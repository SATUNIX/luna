package io.github.satunix.piremote

import okhttp3.ConnectionSpec
import okhttp3.OkHttpClient
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

class PinMismatchException(val seen: String) :
    CertificateException("the certificate does not match the one this phone was linked to")

/**
 * Trusts exactly one certificate, named by its SHA-256 fingerprint. Each computer makes its own
 * self-signed certificate; the phone learns the fingerprint from the QR code (or from the
 * operator comparing it by eye) and from then on accepts nothing else, whatever any CA says.
 *
 * With no pin it accepts any certificate and records what it saw: used only to show a
 * fingerprint to the person linking by hand, who compares it with the computer's screen.
 */
class PinnedTrustManager(private val pin: String?) : X509TrustManager {
    @Volatile
    var seen: String? = null
        private set

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw CertificateException("the computer sent no certificate")
        val fingerprint = Codes.fingerprint(leaf.encoded)
        seen = fingerprint
        if (pin != null && !Codes.same(fingerprint, pin)) throw PinMismatchException(fingerprint)
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        throw CertificateException("pi remote does not accept client connections")
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

object PinnedTls {
    /** A client for one computer: its own TLS context, so no session is shared across pins. */
    fun client(base: OkHttpClient, pin: String?): Pair<OkHttpClient, PinnedTrustManager> {
        val trust = PinnedTrustManager(pin)
        val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf<TrustManager>(trust), null) }
        val client = base.newBuilder()
            .sslSocketFactory(context.socketFactory, trust)
            // The pin names the computer's own certificate, so the address in the URL (a LAN or
            // VPN address, rarely a name) has nothing to add. The check is repeated here so a
            // resumed TLS session is held to the same pin.
            .hostnameVerifier { _, session ->
                if (pin == null) {
                    true
                } else {
                    val leaf = runCatching { session.peerCertificates.firstOrNull() }.getOrNull()
                    leaf != null && Codes.same(Codes.fingerprint(leaf.encoded), pin)
                }
            }
            .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
            .build()
        return client to trust
    }

    fun isPinMismatch(error: Throwable): Boolean {
        var cause: Throwable? = error
        var depth = 0
        while (cause != null && depth++ < 10) {
            if (cause is PinMismatchException) return true
            cause = cause.cause
        }
        return false
    }
}
