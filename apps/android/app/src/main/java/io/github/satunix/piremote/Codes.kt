package io.github.satunix.piremote

import android.util.Base64
import java.security.MessageDigest

/**
 * Identifiers exactly as the computer computes and shows them
 * (packages/web-ui/server/remote/codes.js and tls.js), so the operator can compare screens.
 */
object Codes {
    // Crockford base32 without I, L, O and U.
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private val CODE_RE = Regex("^[0-9A-HJKMNP-TV-Z]{10}$")

    /** Base32 of [bytes], [chars] characters long, most significant bits first. */
    fun base32(bytes: ByteArray, chars: Int): String {
        val out = StringBuilder(chars)
        var acc = 0
        var bits = 0
        for (b in bytes) {
            if (out.length >= chars) break
            acc = (acc shl 8) or (b.toInt() and 0xff)
            bits += 8
            while (bits >= 5 && out.length < chars) {
                out.append(ALPHABET[(acc ushr (bits - 5)) and 31])
                bits -= 5
            }
            acc = acc and ((1 shl bits) - 1)
        }
        require(out.length == chars) { "not enough input for $chars characters" }
        return out.toString()
    }

    fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    /** A device's id: the first 80 bits of SHA-256 over its public key (SPKI DER). */
    fun deviceId(spki: ByteArray): String = base32(sha256(spki), 16)

    fun formatDeviceId(id: String): String = id.chunked(4).joinToString("-")

    /** A typed pairing code in canonical form: upper case, no separators, look-alikes mapped. */
    fun normalizeCode(input: String): String = input.uppercase()
        .replace(Regex("[\\s-]"), "")
        .replace('O', '0')
        .replace(Regex("[IL]"), "1")
        .replace('U', 'V')

    fun isCode(code: String): Boolean = CODE_RE.matches(code)

    /** A certificate's fingerprint: SHA-256 of its DER encoding, base64url without padding. */
    fun fingerprint(certDer: ByteArray): String = base64Url(sha256(certDer))

    /** The fingerprint as /remote shows it: the first 128 bits as 8 groups of 4 hex digits. */
    fun displayFingerprint(fingerprint: String): String {
        val raw = try {
            Base64.decode(fingerprint, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            return "?"
        }
        val hex = raw.joinToString("") { "%02X".format(it.toInt() and 0xff) }
        return hex.take(32).chunked(4).joinToString(" ")
    }

    fun base64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

    fun base64Url(bytes: ByteArray): String =
        Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    /** Constant-time equality for fingerprints and other short secrets. */
    fun same(a: String, b: String): Boolean = MessageDigest.isEqual(a.toByteArray(), b.toByteArray())
}
