package io.github.satunix.piremote

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.time.Instant

/** A computer this phone is linked to. Nothing here is secret: the key stays in the Keystore. */
data class Host(
    val id: String,
    val serverId: String,
    val name: String,
    /** The name the computer gave itself when linked (the user may rename [name]). */
    val serverName: String,
    val addresses: List<String>,
    val port: Int,
    val fingerprint: String,
    val keyAlias: String,
    val deviceId: String,
    val pairedAt: String,
    val lastUsedAt: String? = null,
    val lastAddress: String? = null,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("serverId", serverId)
        .put("name", name)
        .put("serverName", serverName)
        .put("addresses", JSONArray(addresses))
        .put("port", port)
        .put("fingerprint", fingerprint)
        .put("keyAlias", keyAlias)
        .put("deviceId", deviceId)
        .put("pairedAt", pairedAt)
        .put("lastUsedAt", lastUsedAt ?: JSONObject.NULL)
        .put("lastAddress", lastAddress ?: JSONObject.NULL)

    /** What the page may see. */
    fun toPage(): JSONObject = JSONObject()
        .put("id", id)
        .put("name", name)
        .put("addresses", JSONArray(addresses))
        .put("port", port)
        .put("fingerprintDisplay", Codes.displayFingerprint(fingerprint))
        .put("deviceIdDisplay", Codes.formatDeviceId(deviceId))
        .put("pairedAt", pairedAt)
        .put("lastUsedAt", lastUsedAt ?: JSONObject.NULL)

    companion object {
        fun fromJson(o: JSONObject): Host? = runCatching {
            val addresses = o.getJSONArray("addresses").let { a -> List(a.length()) { a.getString(it) } }
            val name = o.getString("name")
            Host(
                id = o.getString("id"),
                serverId = o.getString("serverId"),
                name = name,
                serverName = o.optString("serverName").ifEmpty { name },
                addresses = addresses,
                port = o.getInt("port"),
                fingerprint = o.getString("fingerprint"),
                keyAlias = o.getString("keyAlias"),
                deviceId = o.getString("deviceId"),
                pairedAt = o.getString("pairedAt"),
                lastUsedAt = o.optString("lastUsedAt").takeIf { it.isNotEmpty() && it != "null" },
                lastAddress = o.optString("lastAddress").takeIf { it.isNotEmpty() && it != "null" },
            )
        }.getOrNull()
    }
}

/** The linked computers, in the app's private files (excluded from every backup). */
class HostStore(context: Context) {
    private val file = AtomicFile(File(context.filesDir, "hosts.json"))
    private val hosts = LinkedHashMap<String, Host>()

    init {
        load()
    }

    private fun load() {
        val text = try {
            String(file.readFully(), Charsets.UTF_8)
        } catch (e: FileNotFoundException) {
            return
        }
        val list = runCatching { JSONObject(text).getJSONArray("hosts") }.getOrNull() ?: return
        for (i in 0 until list.length()) {
            val host = list.optJSONObject(i)?.let(Host::fromJson) ?: continue
            hosts[host.id] = host
        }
    }

    private fun save() {
        val body = JSONObject().put("version", 1).put("hosts", JSONArray(hosts.values.map { it.toJson() }))
        val out = file.startWrite()
        try {
            out.write(body.toString().toByteArray(Charsets.UTF_8))
            file.finishWrite(out)
        } catch (e: Exception) {
            file.failWrite(out)
            throw e
        }
    }

    @Synchronized
    fun list(): List<Host> = hosts.values.toList()

    @Synchronized
    fun get(id: String): Host? = hosts[id]

    @Synchronized
    fun byServerId(serverId: String): Host? = hosts.values.firstOrNull { it.serverId == serverId }

    @Synchronized
    fun put(host: Host) {
        hosts[host.id] = host
        save()
    }

    @Synchronized
    fun remove(id: String): Host? {
        val host = hosts.remove(id) ?: return null
        save()
        return host
    }

    @Synchronized
    fun rename(id: String, name: String): Host? {
        val host = hosts[id] ?: return null
        val updated = host.copy(name = name)
        hosts[id] = updated
        save()
        return updated
    }

    /** Remember where and when a computer last answered (written at most once a minute). */
    @Synchronized
    fun touch(id: String, address: String) {
        val host = hosts[id] ?: return
        val now = Instant.now()
        val last = host.lastUsedAt?.let { runCatching { Instant.parse(it) }.getOrNull() }
        if (host.lastAddress == address && last != null && now.epochSecond - last.epochSecond < 60) return
        hosts[id] = host.copy(lastUsedAt = now.toString(), lastAddress = address)
        save()
    }
}
