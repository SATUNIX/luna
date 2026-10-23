package io.github.satunix.piremote

import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Dispatcher
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.BufferedSource
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.UnknownHostException
import java.time.Instant
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Everything the phone says to a computer (packages/web-ui/server/remote/api.ts):
 *
 *   GET  /v1/hello                       who answers at an address (checked against the pin)
 *   POST /v1/pair, GET /v1/pair/:id      linking: code + proof of the new key, then the
 *                                        operator's decision in the terminal
 *   POST /v1/auth/challenge|token        signing in: a Keystore signature over a nonce, bound
 *                                        to the pinned certificate and the server's id
 *   /api/...                             pi-console's API with the short-lived bearer token
 *
 * A computer may have several addresses (its LAN address, its Tailscale address, a name):
 * the phone tries the one that answered last first, then the others a moment later, and keeps
 * whichever answers. Tokens live in memory only.
 */
class Remote(private val context: Context, private val store: HostStore) {
    private val base: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .dispatcher(Dispatcher().apply {
            maxRequests = 64
            maxRequestsPerHost = 16
        })
        .build()

    private val clients = ConcurrentHashMap<String, OkHttpClient>()
    private val longClients = ConcurrentHashMap<String, OkHttpClient>()

    /** Requests to the computer pinned to [fingerprint]. */
    private fun pinned(fingerprint: String): OkHttpClient =
        clients.getOrPut(fingerprint) { PinnedTls.client(base, fingerprint).first }

    /** Event streams and long polls: the computer sends a heartbeat every 15 s. */
    private fun pinnedLong(fingerprint: String): OkHttpClient =
        longClients.getOrPut(fingerprint) { pinned(fingerprint).newBuilder().readTimeout(45, TimeUnit.SECONDS).build() }

    /** Per-computer state: where it answered, and the current token. */
    private class Link {
        val mutex = Mutex()
        @Volatile var address: String? = null
        @Volatile var addressAt = 0L
        var token: String? = null
        var tokenUntil = 0L
        var unlinkedAt = 0L
    }

    private val links = ConcurrentHashMap<String, Link>()
    private fun link(hostId: String): Link = links.getOrPut(hostId) { Link() }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // ----------------------------------------------------------------- plumbing ---

    private class Reply(val status: Int, val json: JSONObject?)

    private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation { runCatching { cancel() } }
        enqueue(object : Callback {
            override fun onResponse(call: Call, response: Response) {
                cont.resume(response)
            }

            override fun onFailure(call: Call, e: IOException) {
                if (cont.isActive) cont.resumeWithException(e)
            }
        })
    }

    private suspend fun exchange(client: OkHttpClient, request: Request, timeoutSec: Long = 0): Reply {
        val call = client.newCall(request)
        if (timeoutSec > 0) call.timeout().timeout(timeoutSec, TimeUnit.SECONDS)
        val response = call.await()
        return withContext(Dispatchers.IO) {
            response.use { r ->
                val text = r.body?.string().orEmpty()
                Reply(r.code, runCatching { JSONObject(text) }.getOrNull())
            }
        }
    }

    private fun jsonBody(body: JSONObject) = body.toString().toRequestBody(JSON)

    private suspend fun postOpen(client: OkHttpClient, address: String, port: Int, path: String, body: JSONObject): Reply =
        exchange(client, Request.Builder().url(url(address, port, path)).post(jsonBody(body)).build(), timeoutSec = 15)

    private suspend fun hello(client: OkHttpClient, address: String, port: Int): JSONObject {
        val reply = exchange(client, Request.Builder().url(url(address, port, "/v1/hello")).get().build(), timeoutSec = 5)
        val json = reply.json
        if (reply.status != 200 || json == null || json.optString("service") != "pi-remote") {
            throw IOException("no pi remote host answered at $address:$port (HTTP ${reply.status})")
        }
        return json
    }

    private class IdentityChanged : IOException("pi remote on that computer was reset")

    /**
     * Try [candidates] (the first at once, each further one 250 ms later) and return the
     * first success; the others are cancelled.
     */
    private suspend fun <T> race(candidates: List<String>, attempt: suspend (String) -> T): T = coroutineScope {
        if (candidates.isEmpty()) throw BridgeError.unreachable("no address")
        val winner = CompletableDeferred<T>()
        val errors = Collections.synchronizedList(mutableListOf<Throwable>())
        val jobs = candidates.mapIndexed { index, candidate ->
            launch {
                if (index > 0) delay(250L * index)
                try {
                    winner.complete(attempt(candidate))
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    errors += e
                    if (errors.size == candidates.size) winner.completeExceptionally(combine(errors))
                }
            }
        }
        try {
            winner.await()
        } finally {
            jobs.forEach { it.cancel() }
        }
    }

    private fun combine(errors: List<Throwable>): BridgeError {
        errors.firstOrNull { it is BridgeError }?.let { return it as BridgeError }
        if (errors.any { it is IdentityChanged }) {
            return BridgeError("unlinked", "unlinked: pi remote on that computer was reset; link this phone again")
        }
        return BridgeError.unreachable(errors.firstOrNull()?.message)
    }

    /** The address [host] answers at now (cached for a minute unless [fresh]). */
    private suspend fun address(host: Host, link: Link, fresh: Boolean = false): String {
        val now = SystemClock.elapsedRealtime()
        val cached = link.address
        if (!fresh && cached != null && now - link.addressAt < 60_000) return cached
        val client = pinned(host.fingerprint)
        val ordered = (listOfNotNull(host.lastAddress) + host.addresses).distinct()
        val found = race(ordered) { candidate ->
            val hello = try {
                hello(client, candidate, host.port)
            } catch (e: IOException) {
                // Another device holding the address (the same private address on another network) answers
                // with its own certificate: that only means "not here". A pi remote host with
                // a new certificate is this computer after /remote reset.
                if (PinnedTls.isPinMismatch(e) && isPiRemote(candidate, host.port)) throw BridgeError.pinMismatch()
                throw e
            }
            if (hello.optString("serverId") != host.serverId) throw IdentityChanged()
            candidate
        }
        link.address = found
        link.addressAt = SystemClock.elapsedRealtime()
        return found
    }

    /** Whether a pi remote host answers at [address] (no pin: nothing is sent but the question). */
    private suspend fun isPiRemote(address: String, port: Int): Boolean = try {
        hello(PinnedTls.client(base, null).first, address, port)
        true
    } catch (e: IOException) {
        false
    }

    /** A bearer token for [host], signing in when there is none (or [renew]). */
    private suspend fun token(host: Host, link: Link, address: String, renew: Boolean = false): String = link.mutex.withLock {
        val now = SystemClock.elapsedRealtime()
        val current = link.token
        if (!renew && current != null && now < link.tokenUntil) return@withLock current
        link.token = null
        // A phone the computer no longer knows stops asking for a while: repeated failed
        // sign-ins would get its address blocked.
        if (link.unlinkedAt != 0L && now - link.unlinkedAt < 120_000) throw BridgeError.unlinked()
        val client = pinned(host.fingerprint)
        val challenge = postOpen(client, address, host.port, "/v1/auth/challenge", JSONObject().put("deviceId", host.deviceId))
        val nonce = challenge.json?.optString("nonce").orEmpty()
        if (challenge.status == 429) throw rateLimited()
        if (challenge.status != 200 || nonce.isEmpty()) throw signInFailed(challenge)
        val serverId = challenge.json?.optString("serverId").orEmpty()
        if (serverId != host.serverId) throw BridgeError("unlinked", "unlinked: pi remote on that computer was reset; link this phone again")
        val payload = listOf("pirc-auth-v1", host.deviceId, nonce, host.fingerprint, serverId).joinToString("\n")
        val signature = withContext(Dispatchers.IO) { DeviceKeys.sign(host.keyAlias, payload.toByteArray(Charsets.UTF_8)) }
        val reply = postOpen(
            client, address, host.port, "/v1/auth/token",
            JSONObject().put("deviceId", host.deviceId).put("nonce", nonce).put("signature", Codes.base64(signature)),
        )
        if (reply.status == 401 && reply.json?.optString("error").orEmpty().contains("not linked")) {
            link.unlinkedAt = now
            throw BridgeError.unlinked()
        }
        if (reply.status == 429) throw rateLimited()
        val token = reply.json?.optString("token").orEmpty()
        if (reply.status != 200 || token.isEmpty()) throw signInFailed(reply)
        val ttlSec = reply.json?.optLong("expiresInSec", 3600) ?: 3600
        link.unlinkedAt = 0
        link.token = token
        link.tokenUntil = now + (ttlSec - 60).coerceAtLeast(30) * 1000
        token
    }

    private fun rateLimited() = BridgeError("rate_limited", "the computer is refusing this phone for a while after failed attempts; try again in 15 minutes", 429)

    private fun signInFailed(reply: Reply) = BridgeError(
        "auth_failed",
        "signing in to the computer failed: ${reply.json?.optString("error")?.takeIf { it.isNotEmpty() } ?: "HTTP ${reply.status}"}",
        reply.status,
    )

    private fun checkApiPath(path: String) {
        if (!path.startsWith("/api/") || path.length > 2000 || path.contains("..") || path.any { it <= ' ' || it == '\\' || it == '#' }) {
            throw BridgeError("bad_request", "the app only forwards /api/ paths")
        }
    }

    private fun beforeSend(e: IOException) =
        e is ConnectException || e is NoRouteToHostException || e is UnknownHostException

    // ------------------------------------------------------------------ the API ---

    /** One JSON request to /api on [hostId]. Returns {status, json}. */
    suspend fun request(hostId: String, method: String, path: String, body: Any?): JSONObject {
        checkApiPath(path)
        val verb = method.uppercase()
        if (verb !in setOf("GET", "POST", "PUT", "PATCH", "DELETE")) throw BridgeError("bad_request", "unsupported method $method")
        val host = store.get(hostId) ?: throw BridgeError("unknown_host", "that computer is not linked on this phone")
        val link = link(hostId)
        var retried = false
        while (true) {
            try {
                val address = address(host, link, fresh = retried)
                var token = token(host, link, address)
                var reply = send(host, address, verb, path, body, token)
                if (reply.status == 401) {
                    token = token(host, link, address, renew = true)
                    reply = send(host, address, verb, path, body, token)
                }
                store.touch(host.id, address)
                return JSONObject().put("status", reply.status).put("json", reply.json ?: JSONObject.NULL)
            } catch (e: IOException) {
                link.address = null
                if (PinnedTls.isPinMismatch(e)) throw BridgeError.pinMismatch()
                // The phone may have moved (Wi-Fi to mobile data and the VPN): look again, once.
                // A request that may have reached the computer is not sent twice.
                if (!retried && (verb == "GET" || verb == "DELETE" || beforeSend(e))) {
                    retried = true
                    continue
                }
                throw BridgeError.unreachable(e.message)
            }
        }
    }

    private suspend fun send(host: Host, address: String, verb: String, path: String, body: Any?, token: String): Reply {
        val builder = Request.Builder().url(url(address, host.port, path)).header("Authorization", "Bearer $token")
        // The host wants JSON on every state-changing request, bodiless ones included (as
        // pi-console's own client sends it), so DELETE carries an empty object too.
        val payload = when (body) {
            null, JSONObject.NULL -> if (verb == "GET") null else "{}"
            is JSONObject, is JSONArray -> body.toString()
            else -> throw BridgeError("bad_request", "a request body must be a JSON object")
        }
        builder.method(verb, payload?.toRequestBody(JSON))
        return exchange(pinned(host.fingerprint), builder.build(), timeoutSec = 60)
    }

    // ------------------------------------------------------------ event streams ---

    private class StreamRecord {
        @Volatile var call: Call? = null
        @Volatile var job: Job? = null
        @Volatile var closed = false
        var hostId: String = ""
    }

    private val streams = ConcurrentHashMap<String, StreamRecord>()
    private val streamIds = AtomicInteger(1)

    fun newStreamId(hostId: String): String {
        val id = "s${streamIds.getAndIncrement()}"
        streams[id] = StreamRecord().also { it.hostId = hostId }
        return id
    }

    /**
     * Read the server-sent events at [path] and hand each to [sink] as a stream.frame message;
     * a stream.state message ("closed" or "error") ends it, unless the page closed it.
     */
    fun startStream(streamId: String, hostId: String, path: String, sink: (JSONObject) -> Unit) {
        val record = streams[streamId] ?: return
        record.job = scope.launch {
            var state = "closed"
            var message: String? = null
            try {
                readStream(record, streamId, hostId, path, sink)
            } catch (e: CancellationException) {
                return@launch
            } catch (e: BridgeError) {
                state = "error"
                message = e.message
            } catch (e: IOException) {
                state = "error"
                message = if (PinnedTls.isPinMismatch(e)) BridgeError.pinMismatch().message else (e.message ?: "connection lost")
            } finally {
                streams.remove(streamId)
            }
            if (!record.closed) {
                sink(JSONObject().put("event", "stream.state").put("streamId", streamId).put("state", state).put("message", message ?: JSONObject.NULL))
            }
        }
    }

    private suspend fun readStream(record: StreamRecord, streamId: String, hostId: String, path: String, sink: (JSONObject) -> Unit) {
        checkApiPath(path)
        val host = store.get(hostId) ?: throw BridgeError("unknown_host", "that computer is not linked on this phone")
        val link = link(hostId)
        var renew = false
        while (true) {
            val address = address(host, link, fresh = renew)
            val token = token(host, link, address, renew)
            val request = Request.Builder()
                .url(url(address, host.port, path))
                .header("Authorization", "Bearer $token")
                .header("Accept", "text/event-stream")
                .build()
            val call = pinnedLong(host.fingerprint).newCall(request)
            record.call = call
            if (record.closed) return
            val response = try {
                call.await()
            } catch (e: IOException) {
                link.address = null
                throw e
            }
            try {
                if (response.code == 401 && !renew) {
                    renew = true
                    continue
                }
                if (response.code != 200) {
                    val error = withContext(Dispatchers.IO) { runCatching { JSONObject(response.body!!.string()).optString("error") }.getOrNull() }
                    throw BridgeError("http_${response.code}", error?.takeIf { it.isNotEmpty() } ?: "HTTP ${response.code}", response.code)
                }
                store.touch(host.id, address)
                withContext(Dispatchers.IO) { readEvents(response.body!!.source(), streamId, record, sink) }
                return
            } finally {
                response.close()
            }
        }
    }

    private fun readEvents(source: BufferedSource, streamId: String, record: StreamRecord, sink: (JSONObject) -> Unit) {
        var name = "message"
        val data = StringBuilder()
        while (!record.closed) {
            val line = source.readUtf8Line() ?: return
            if (line.isEmpty()) {
                if (data.isNotEmpty()) {
                    sink(JSONObject().put("event", "stream.frame").put("streamId", streamId).put("name", name).put("data", data.toString()))
                }
                name = "message"
                data.setLength(0)
                continue
            }
            if (line.startsWith(":")) continue
            val colon = line.indexOf(':')
            val field = if (colon == -1) line else line.substring(0, colon)
            val value = if (colon == -1) "" else line.substring(colon + 1).removePrefix(" ")
            when (field) {
                "event" -> name = value
                "data" -> {
                    if (data.isNotEmpty()) data.append('\n')
                    data.append(value)
                }
            }
        }
    }

    fun closeStream(streamId: String) {
        val record = streams.remove(streamId) ?: return
        record.closed = true
        record.call?.cancel()
        record.job?.cancel()
    }

    fun closeAllStreams(hostId: String? = null) {
        for ((id, record) in streams.entries.toList()) if (hostId == null || record.hostId == hostId) closeStream(id)
    }

    // --------------------------------------------------------------- computers ---

    suspend fun probeHost(hostId: String): JSONObject {
        val host = store.get(hostId) ?: throw BridgeError("unknown_host", "that computer is not linked on this phone")
        val started = SystemClock.elapsedRealtime()
        return try {
            val address = address(host, link(hostId), fresh = true)
            JSONObject().put("reachable", true).put("address", address).put("latencyMs", SystemClock.elapsedRealtime() - started)
        } catch (e: BridgeError) {
            JSONObject().put("reachable", false).put("code", e.code).put("message", e.message)
        }
    }

    /** Forget [hostId] here; with [unlinkRemote], first ask the computer to forget this phone. */
    suspend fun removeHost(hostId: String, unlinkRemote: Boolean): JSONObject {
        val host = store.get(hostId) ?: return JSONObject().put("removed", false)
        var problem: BridgeError? = null
        if (unlinkRemote) {
            try {
                val reply = withTimeout(10_000) { request(hostId, "DELETE", "/api/remote/device", null) }
                val status = reply.optInt("status")
                if (status >= 400) problem = BridgeError("http_$status", reply.optJSONObject("json")?.optString("error") ?: "HTTP $status", status)
            } catch (e: BridgeError) {
                // A computer that no longer knows this phone (or was reset) has nothing to forget.
                if (e.code != "unlinked" && e.code != "pin_mismatch") problem = e
            } catch (e: TimeoutCancellationException) {
                problem = BridgeError.unreachable("timed out")
            }
        }
        closeAllStreams(hostId)
        store.remove(hostId)
        DeviceKeys.delete(host.keyAlias)
        links.remove(hostId)
        val out = JSONObject().put("removed", true)
        problem?.let { out.put("error", JSONObject().put("code", it.code).put("message", it.message)) }
        return out
    }

    // ------------------------------------------------------------------ linking ---

    private class Pending(
        val id: String,
        val alias: String,
        val spki: ByteArray,
        val serverId: String,
        val name: String,
        val addresses: List<String>,
        val address: String,
        val port: Int,
        val fingerprint: String,
        val requestId: String,
        val deviceId: String,
    ) {
        @Volatile var cancelled = false
        @Volatile var call: Call? = null
    }

    private val pending = ConcurrentHashMap<String, Pending>()

    private data class Offer(val addresses: List<String>, val port: Int, val fingerprint: String, val code: String, val name: String)

    private fun offerFrom(params: JSONObject): Offer {
        if (params.has("link")) {
            val uri = Uri.parse(params.getString("link"))
            if (uri.scheme != "pirc" || uri.host != "pair") throw BridgeError("bad_link", "that is not a pi remote pairing link")
            val addresses = uri.getQueryParameter("h").orEmpty().split(',').map { it.trim() }.filter { it.isNotEmpty() }
            val port = uri.getQueryParameter("p")?.toIntOrNull() ?: 0
            val fingerprint = uri.getQueryParameter("f").orEmpty()
            val code = uri.getQueryParameter("c").orEmpty()
            val name = uri.getQueryParameter("n")?.takeIf { it.isNotBlank() } ?: addresses.firstOrNull().orEmpty()
            return checkOffer(Offer(addresses, port, fingerprint, code, name))
        }
        val list = params.optJSONArray("addresses") ?: JSONArray()
        val addresses = List(list.length()) { list.optString(it).trim() }.filter { it.isNotEmpty() }
        return checkOffer(Offer(addresses, params.optInt("port"), params.optString("fingerprint"), params.optString("code"), addresses.firstOrNull().orEmpty()))
    }

    private fun checkOffer(offer: Offer): Offer {
        if (offer.addresses.isEmpty() || offer.addresses.size > 8 || offer.addresses.any { !validAddress(it) }) {
            throw BridgeError("bad_link", "the pairing details have no usable address")
        }
        if (offer.port !in 1..65535) throw BridgeError("bad_link", "the pairing details have no usable port")
        if (!Regex("^[A-Za-z0-9_-]{43}$").matches(offer.fingerprint)) throw BridgeError("bad_link", "the pairing details have no certificate fingerprint")
        val code = Codes.normalizeCode(offer.code)
        if (!Codes.isCode(code)) throw BridgeError("bad_code", "that is not a pairing code: it has 10 letters and digits")
        return offer.copy(code = code, name = offer.name.take(64))
    }

    /** The name this phone gives itself: the one set in Android's settings, or the model. */
    private fun deviceName(): String {
        val set = runCatching { Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
        val maker = Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
        val model = if (Build.MODEL.startsWith(Build.MANUFACTURER, ignoreCase = true)) Build.MODEL else "$maker ${Build.MODEL}"
        return (set?.takeIf { it.isNotBlank() } ?: model).replace(Regex("[\\p{Cntrl}\\u2028\\u2029]"), " ").trim().take(64)
    }

    /** Check who answers at [address]:[port] without a pin, for linking by hand. */
    suspend fun probeNew(address: String, port: Int): JSONObject {
        if (!validAddress(address) || port !in 1..65535) throw BridgeError("bad_request", "enter one of the addresses /remote shows, and the port")
        val (client, trust) = PinnedTls.client(base, null)
        val hello = try {
            hello(client, address, port)
        } catch (e: IOException) {
            throw BridgeError.unreachable(e.message)
        }
        val fingerprint = trust.seen ?: throw BridgeError("pair_failed", "the computer sent no certificate")
        return JSONObject()
            .put("fingerprint", fingerprint)
            .put("fingerprintDisplay", Codes.displayFingerprint(fingerprint))
            .put("name", hello.optString("name").ifEmpty { address })
            .put("serverId", hello.optString("serverId"))
    }

    /**
     * Start linking: reach the computer under the pin, make a fresh Keystore key, and present
     * the code with a signature that binds it to that key and to the pinned certificate.
     */
    suspend fun pairBegin(params: JSONObject): JSONObject {
        val offer = offerFrom(params)
        val client = pinned(offer.fingerprint)
        val (address, hello) = race(offer.addresses) { candidate ->
            try {
                candidate to hello(client, candidate, offer.port)
            } catch (e: IOException) {
                if (PinnedTls.isPinMismatch(e)) {
                    throw BridgeError("pin_mismatch", "the computer at $candidate presented a different certificate from the one in the pairing code; show a fresh code with /remote pair")
                }
                throw e
            }
        }
        val serverId = hello.optString("serverId")
        val alias = "pirc-" + UUID.randomUUID()
        val spki = withContext(Dispatchers.IO) { DeviceKeys.generate(context, alias) }
        try {
            val publicKey = Codes.base64(spki)
            val name = deviceName()
            val proofPayload = listOf("pirc-pair-v1", offer.code, offer.fingerprint, publicKey, name).joinToString("\n")
            val proof = withContext(Dispatchers.IO) { DeviceKeys.sign(alias, proofPayload.toByteArray(Charsets.UTF_8)) }
            val reply = try {
                postOpen(
                    client, address, offer.port, "/v1/pair",
                    JSONObject().put("code", offer.code).put("publicKey", publicKey).put("name", name)
                        .put("proof", Codes.base64(proof)).put("platform", "android"),
                )
            } catch (e: IOException) {
                throw if (PinnedTls.isPinMismatch(e)) BridgeError.pinMismatch() else BridgeError.unreachable(e.message)
            }
            val json = reply.json
            if (reply.status != 202 || json == null) {
                throw BridgeError(json?.optString("code")?.takeIf { it.isNotEmpty() } ?: "pair_failed", json?.optString("error")?.takeIf { it.isNotEmpty() } ?: "linking failed (HTTP ${reply.status})", reply.status)
            }
            val deviceId = Codes.deviceId(spki)
            if (json.optString("deviceId") != deviceId) {
                throw BridgeError("pair_failed", "the computer computed a different device ID for this phone; linking stopped")
            }
            val hostName = json.optString("serverName").ifEmpty { hello.optString("name").ifEmpty { offer.name } }
            val entry = Pending(
                id = UUID.randomUUID().toString(),
                alias = alias,
                spki = spki,
                serverId = json.optString("serverId").ifEmpty { serverId },
                name = hostName,
                addresses = offer.addresses,
                address = address,
                port = offer.port,
                fingerprint = offer.fingerprint,
                requestId = json.getString("requestId"),
                deviceId = deviceId,
            )
            pending[entry.id] = entry
            return JSONObject().put("pairingId", entry.id).put("deviceIdDisplay", Codes.formatDeviceId(deviceId)).put("hostName", hostName)
        } catch (e: Throwable) {
            DeviceKeys.delete(alias)
            throw e
        }
    }

    /** Wait for the operator's decision; on approval the computer is saved. */
    suspend fun pairWait(pairingId: String): JSONObject {
        val entry = pending[pairingId] ?: throw BridgeError("unknown_pairing", "that linking attempt has ended")
        var approved = false
        try {
            val client = pinnedLong(entry.fingerprint)
            var failures = 0
            while (true) {
                if (entry.cancelled) return JSONObject().put("state", "cancelled")
                val call = client.newCall(Request.Builder().url(url(entry.address, entry.port, "/v1/pair/${entry.requestId}?wait=25")).get().build())
                entry.call = call
                val reply = try {
                    val response = call.await()
                    withContext(Dispatchers.IO) { response.use { Reply(it.code, runCatching { JSONObject(it.body?.string().orEmpty()) }.getOrNull()) } }
                } catch (e: IOException) {
                    if (entry.cancelled) return JSONObject().put("state", "cancelled")
                    if (PinnedTls.isPinMismatch(e)) throw BridgeError.pinMismatch()
                    if (++failures >= 6) throw BridgeError.unreachable(e.message)
                    delay(3000)
                    continue
                }
                failures = 0
                if (entry.cancelled) return JSONObject().put("state", "cancelled")
                if (reply.status == 404) return JSONObject().put("state", "expired").put("reason", "the computer no longer knows this request")
                if (reply.status == 429) {
                    delay(10_000)
                    continue
                }
                val json = reply.json ?: throw BridgeError("pair_failed", "unexpected answer (HTTP ${reply.status})", reply.status)
                when (val state = json.optString("state")) {
                    "pending" -> continue
                    "approved" -> {
                        val host = save(entry)
                        approved = true
                        return JSONObject().put("state", "approved").put("host", host.toPage())
                    }
                    else -> return JSONObject().put("state", state.ifEmpty { "failed" }).put("reason", json.optString("reason").ifEmpty { JSONObject.NULL })
                }
            }
        } finally {
            pending.remove(pairingId)
            if (!approved) DeviceKeys.delete(entry.alias)
        }
    }

    private fun save(entry: Pending): Host {
        // The same computer linked again, or the same computer after /remote reset (a new
        // identity at the same name, port and address): its old entry is replaced.
        val existing = store.byServerId(entry.serverId)
            ?: store.list().firstOrNull { it.serverName == entry.name && it.port == entry.port && it.addresses.any(entry.addresses::contains) }
        val now = Instant.now().toString()
        val host = Host(
            id = existing?.id ?: UUID.randomUUID().toString(),
            serverId = entry.serverId,
            name = existing?.name ?: entry.name,
            serverName = entry.name,
            addresses = entry.addresses,
            port = entry.port,
            fingerprint = entry.fingerprint,
            keyAlias = entry.alias,
            deviceId = entry.deviceId,
            pairedAt = now,
            lastUsedAt = now,
            lastAddress = entry.address,
        )
        store.put(host)
        if (existing != null && existing.keyAlias != entry.alias) DeviceKeys.delete(existing.keyAlias)
        if (existing != null) closeAllStreams(existing.id)
        links.remove(host.id)
        return host
    }

    fun pairCancel(pairingId: String) {
        val entry = pending[pairingId] ?: return
        entry.cancelled = true
        entry.call?.cancel()
    }

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()
        private val NAME_RE = Regex("^[A-Za-z0-9]([A-Za-z0-9.-]{0,252})$")
        private val V4_RE = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$")

        fun validAddress(address: String): Boolean = when {
            address.contains(':') -> address.length <= 45 && Regex("^[0-9A-Fa-f:.]+$").matches(address)
            V4_RE.matches(address) -> address.split('.').all { it.toInt() <= 255 }
            else -> NAME_RE.matches(address)
        }

        fun url(address: String, port: Int, path: String): String {
            val host = if (address.contains(':')) "[$address]" else address
            return "https://$host:$port$path"
        }
    }
}
