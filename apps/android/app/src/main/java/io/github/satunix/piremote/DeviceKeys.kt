package io.github.satunix.piremote

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * The phone's identity for each computer: one EC P-256 key pair per linked computer, made and
 * kept in the Android Keystore (in StrongBox when the phone has one). The private key never
 * leaves the secure hardware; the computer only ever sees the public key and signatures.
 */
object DeviceKeys {
    private const val PROVIDER = "AndroidKeyStore"

    private fun keyStore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

    /** Create a fresh signing key under [alias]; returns its public key as SPKI DER. */
    fun generate(context: Context, alias: String): ByteArray {
        val strongBox = context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
        if (strongBox) {
            try {
                return create(alias, strongBox = true)
            } catch (e: StrongBoxUnavailableException) {
                // fall back to the TEE
            } catch (e: ProviderException) {
                // some StrongBox implementations fail late; fall back to the TEE
            }
        }
        return create(alias, strongBox = false)
    }

    private fun create(alias: String, strongBox: Boolean): ByteArray {
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setIsStrongBoxBacked(strongBox)
            .build()
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER)
        generator.initialize(spec)
        return generator.generateKeyPair().public.encoded
    }

    /** An ECDSA (SHA-256, DER-encoded) signature over [payload] with the key under [alias]. */
    fun sign(alias: String, payload: ByteArray): ByteArray {
        val key = keyStore().getKey(alias, null) as? PrivateKey ?: throw BridgeError.unlinked()
        return Signature.getInstance("SHA256withECDSA").run {
            initSign(key)
            update(payload)
            sign()
        }
    }

    fun delete(alias: String) {
        runCatching { keyStore().deleteEntry(alias) }
    }

    /** Where the key under [alias] lives, as people say it: "StrongBox", "secure hardware" or "software". */
    fun storage(alias: String): String? {
        val key = runCatching { keyStore().getKey(alias, null) as? PrivateKey }.getOrNull() ?: return null
        val info = runCatching {
            KeyFactory.getInstance(key.algorithm, PROVIDER).getKeySpec(key, KeyInfo::class.java)
        }.getOrNull() ?: return null
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            when (info.securityLevel) {
                KeyProperties.SECURITY_LEVEL_STRONGBOX -> "StrongBox"
                KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT, KeyProperties.SECURITY_LEVEL_UNKNOWN_SECURE -> "secure hardware"
                else -> "software"
            }
        } else {
            @Suppress("DEPRECATION")
            if (info.isInsideSecureHardware) "secure hardware" else "software"
        }
    }
}
