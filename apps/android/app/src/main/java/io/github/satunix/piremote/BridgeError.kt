package io.github.satunix.piremote

/**
 * A failure the page can act on. [code] is one of the values main.js knows
 * ("unreachable", "unlinked", "pin_mismatch") or a short description of anything else.
 */
class BridgeError(
    val code: String,
    message: String,
    val status: Int? = null,
    cause: Throwable? = null,
) : Exception(message, cause) {
    companion object {
        fun unreachable(detail: String? = null) = BridgeError(
            "unreachable",
            if (detail.isNullOrBlank()) "the computer cannot be reached" else "the computer cannot be reached ($detail)",
        )

        fun unlinked() = BridgeError("unlinked", "unlinked: this phone is no longer linked to that computer")

        fun pinMismatch() = BridgeError(
            "pin_mismatch",
            "the computer presented a different certificate from the one this phone was linked to",
        )
    }
}
