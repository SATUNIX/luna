package io.github.satunix.piremote

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * The page's requests (packages/web-ui/mobile/js/native.js), answered by the app:
 *
 *   page -> app   {"id": 7, "method": "api.request", "params": {...}}
 *   app -> page   {"id": 7, "ok": true, "result": {...}}  or  {"id": 7, "ok": false, "error": {...}}
 *
 * Only the methods below exist. The page gets no network of its own (its CSP forbids it), so
 * this list is everything the interface can make the app do.
 */
class Bridge(
    private val shell: Shell,
    private val store: HostStore,
    private val remote: Remote,
) {
    /** What the bridge needs from the activity. */
    interface Shell {
        fun post(message: JSONObject)
        fun info(): JSONObject
        suspend fun setLock(enabled: Boolean): Boolean
        fun setSecureScreen(enabled: Boolean): Boolean
        fun haptic()
        fun openUrl(url: String)
        suspend fun scan(): String?
        fun exit()
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun onMessage(raw: String) {
        val message = try {
            JSONObject(raw)
        } catch (e: JSONException) {
            return
        }
        val id = message.opt("id") ?: return
        val method = message.optString("method")
        val params = message.optJSONObject("params") ?: JSONObject()
        scope.launch {
            try {
                if (method == "api.stream") {
                    // The page learns the stream's id from this answer and drops frames for ids
                    // it does not know yet, so the answer goes out before the first frame.
                    val hostId = params.optString("hostId")
                    val path = params.optString("path")
                    val streamId = remote.newStreamId(hostId)
                    reply(id, JSONObject().put("streamId", streamId))
                    remote.startStream(streamId, hostId, path) { frame -> shell.post(frame) }
                    return@launch
                }
                reply(id, handle(method, params))
            } catch (e: CancellationException) {
                throw e
            } catch (e: BridgeError) {
                fail(id, e.code, e.message ?: e.code, e.status)
            } catch (e: Exception) {
                fail(id, "internal", e.message ?: e.javaClass.simpleName, null)
            }
        }
    }

    private suspend fun handle(method: String, p: JSONObject): JSONObject = when (method) {
        "app.info" -> withContext(Dispatchers.Main) { shell.info() }
        "app.setLock" -> JSONObject().put("lockEnabled", withContext(Dispatchers.Main) { shell.setLock(p.optBoolean("enabled")) })
        "app.setSecureScreen" -> JSONObject().put("secureScreen", withContext(Dispatchers.Main) { shell.setSecureScreen(p.optBoolean("enabled")) })
        "app.haptic" -> withContext(Dispatchers.Main) { shell.haptic(); JSONObject() }
        "app.openUrl" -> withContext(Dispatchers.Main) { shell.openUrl(p.optString("url")); JSONObject() }
        "app.exit" -> withContext(Dispatchers.Main) { shell.exit(); JSONObject() }

        "hosts.list" -> JSONObject().put("hosts", JSONArray(store.list().map { it.toPage() }))
        "hosts.probe" -> remote.probeHost(p.optString("hostId"))
        "hosts.rename" -> {
            val name = p.optString("name").replace(Regex("[\\p{Cntrl}\\u2028\\u2029]"), " ").trim().take(64)
            if (name.isEmpty()) throw BridgeError("bad_request", "a name cannot be empty")
            store.rename(p.optString("hostId"), name) ?: throw BridgeError("unknown_host", "that computer is not linked on this phone")
            JSONObject()
        }
        "hosts.remove" -> remote.removeHost(p.optString("hostId"), p.optBoolean("unlinkRemote"))

        "pair.scan" -> JSONObject().put("link", withContext(Dispatchers.Main) { shell.scan() } ?: JSONObject.NULL)
        "pair.probe" -> remote.probeNew(p.optString("address").trim(), p.optInt("port"))
        "pair.begin" -> remote.pairBegin(p)
        "pair.wait" -> remote.pairWait(p.optString("pairingId"))
        "pair.cancel" -> {
            remote.pairCancel(p.optString("pairingId"))
            JSONObject()
        }

        "api.request" -> remote.request(p.optString("hostId"), p.optString("method", "GET"), p.optString("path"), p.opt("body"))
        "api.closeStream" -> {
            remote.closeStream(p.optString("streamId"))
            JSONObject()
        }
        else -> throw BridgeError("unknown_method", "the app has no method \"$method\"")
    }

    private fun reply(id: Any, result: JSONObject) {
        shell.post(JSONObject().put("id", id).put("ok", true).put("result", result))
    }

    private fun fail(id: Any, code: String, message: String, status: Int?) {
        val error = JSONObject().put("code", code).put("message", message)
        if (status != null) error.put("status", status)
        shell.post(JSONObject().put("id", id).put("ok", false).put("error", error))
    }

    /** The page went away (reload or a new page): its streams go with it. */
    fun pageGone() {
        remote.closeAllStreams()
    }

    fun close() {
        remote.closeAllStreams()
        scope.cancel()
    }
}
