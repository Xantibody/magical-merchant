package com.magical_merchant.app.widget

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import java.util.Locale
import org.json.JSONObject

/**
 * What the capture sheet can tell the entry about where it was written.
 *
 * In the app the WebView answers this (`lib/client-context.ts`); the widget has
 * no WebView, and the Rust side sees nothing on Android — no `battery` crate,
 * no SystemConfiguration. Without this, a widget entry carries only `os` and
 * `arch` while an in-app entry carries battery, network and place.
 *
 * The JSON keys are the ones `ClientContext` (src-tauri/src/device.rs)
 * deserializes, so this and the WebView speak the same shape. `networkType` is
 * an externally tagged enum there: the string has to be one of WiFi, Ethernet,
 * Mobile, Offline or the whole object fails to parse.
 *
 * Everything here is synchronous. The sheet is open for as long as it takes to
 * type one line, and a value that arrives after `finish()` is a value the entry
 * never gets — which is why location is read from the last known fix rather
 * than measured.
 */
internal object WidgetContext {
    /** Whatever could be gathered, as JSON. Never throws; `{}` at worst. */
    fun collect(context: Context): String = runCatching { build(context) }.getOrElse { "{}" }

    private fun build(context: Context): String {
        val json = JSONObject()

        putBattery(json, context)
        networkType(context)?.let { json.put("networkType", it) }
        json.put("osVersion", Build.VERSION.RELEASE)
        json.put("locale", locale())
        putLocation(json, context)

        return json.toString()
    }

    /**
     * A null receiver reads the sticky ACTION_BATTERY_CHANGED without
     * registering anything, so there is nothing to unregister and no
     * RECEIVER_EXPORTED flag to decide on.
     */
    private fun putBattery(json: JSONObject, context: Context) {
        val status = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            ?: return

        val level = status.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = status.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        if (level >= 0 && scale > 0) {
            json.put("battery", level * 100 / scale)
        }

        // Full counts as charging, as it does on macOS: the point of the field
        // is whether the entry was written on mains power.
        when (status.getIntExtra(BatteryManager.EXTRA_STATUS, -1)) {
            BatteryManager.BATTERY_STATUS_CHARGING, BatteryManager.BATTERY_STATUS_FULL ->
                json.put("isCharging", true)
            BatteryManager.BATTERY_STATUS_DISCHARGING, BatteryManager.BATTERY_STATUS_NOT_CHARGING ->
                json.put("isCharging", false)
        }
    }

    /**
     * Which way the phone was reachable. Reads transports, not the SSID, so no
     * location permission is involved — the same trade the macOS side makes.
     */
    private fun networkType(context: Context): String? {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return null
        val network = manager.activeNetwork ?: return "Offline"
        val capabilities = manager.getNetworkCapabilities(network) ?: return "Offline"

        return when {
            !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) -> "Offline"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "WiFi"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "Mobile"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "Ethernet"
            // VPN over something unnamed, Bluetooth tethering, USB. Rounding an
            // unknown transport to WiFi would make the record lie, so drop it.
            else -> null
        }
    }

    /** `ja_JP`, the shape `navigator.language` is normalized to in the app. */
    private fun locale(): String = Locale.getDefault().let { locale ->
        if (locale.country.isEmpty()) locale.language else "${locale.language}_${locale.country}"
    }

    /**
     * The last fix the OS already has, if location is permitted at all.
     *
     * Never requests the permission and never asks for a new fix. The sheet is
     * meant to be typed into the moment it opens; a permission dialog on the
     * home screen, or a wait for GPS, costs more than the coordinate is worth.
     * An entry written before the app has ever been granted location simply has
     * none, which is the same as today.
     */
    private fun putLocation(json: JSONObject, context: Context) {
        if (!locationPermitted(context)) {
            return
        }

        val manager = context.getSystemService(LocationManager::class.java) ?: return
        val fix = manager.allProviders
            .mapNotNull { provider ->
                runCatching { manager.getLastKnownLocation(provider) }.getOrNull()
            }
            .maxByOrNull { it.time } ?: return

        json.put("latitude", fix.latitude)
        json.put("longitude", fix.longitude)
    }

    /**
     * Coarse is enough. The recorded coordinate is only ever read back through
     * the geocoder, which stops at the municipality.
     */
    private fun locationPermitted(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
}
