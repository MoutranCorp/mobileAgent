package com.ondevice.agent.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Bg = Color(0xFF0F1115)
val BgElev = Color(0xFF171A21)
val BgElev2 = Color(0xFF1F232C)
val Border = Color(0xFF2A2F3A)
val TextMain = Color(0xFFE6E8EE)
val TextDim = Color(0xFF9AA3B2)
val Accent = Color(0xFF6D5EFC)
val Green = Color(0xFF38B35A)
val Red = Color(0xFFE5534B)
val Amber = Color(0xFFD8A020)

private val DarkScheme = darkColorScheme(
    primary = Accent,
    onPrimary = Color.White,
    background = Bg,
    onBackground = TextMain,
    surface = BgElev,
    onSurface = TextMain,
    surfaceVariant = BgElev2,
    onSurfaceVariant = TextDim,
    outline = Border,
    error = Red,
)

@Composable
fun AgentTheme(content: @Composable () -> Unit) {
    // Always dark — the UI is tuned for it (and matches the web UI).
    MaterialTheme(colorScheme = DarkScheme, content = content)
}
