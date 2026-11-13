package com.garlictransfer.android.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val GarlicBackground = Color(0xFF0E0E13)
val GarlicSurface = Color(0xFF17171F)
val GarlicSurfaceVariant = Color(0xFF1F1F29)
val GarlicPrimary = Color(0xFFC9B8E8)
val GarlicSecondary = Color(0xFFE8E0CE)
val GarlicTertiary = Color(0xFF9FD4B4)
val GarlicError = Color(0xFFF2B8B5)

val GarlicColorScheme: ColorScheme = darkColorScheme(
    primary = GarlicPrimary,
    onPrimary = Color(0xFF2B2338),
    primaryContainer = Color(0xFF3A3348),
    onPrimaryContainer = Color(0xFFE9DEFA),
    secondary = GarlicSecondary,
    onSecondary = Color(0xFF36322A),
    secondaryContainer = Color(0xFF403B32),
    onSecondaryContainer = Color(0xFFF4EDDC),
    tertiary = GarlicTertiary,
    onTertiary = Color(0xFF1E3527),
    tertiaryContainer = Color(0xFF2C4636),
    onTertiaryContainer = Color(0xFFC4EAD2),
    error = GarlicError,
    onError = Color(0xFF4A2725),
    errorContainer = Color(0xFF5C3330),
    onErrorContainer = Color(0xFFF9DEDC),
    background = GarlicBackground,
    onBackground = Color(0xFFE6E2EC),
    surface = GarlicSurface,
    onSurface = Color(0xFFE6E2EC),
    surfaceVariant = GarlicSurfaceVariant,
    onSurfaceVariant = Color(0xFFC7C3D1),
    outline = Color(0xFF5A5766),
    outlineVariant = Color(0xFF34343F),
    inverseSurface = Color(0xFFE6E2EC),
    inverseOnSurface = Color(0xFF232330),
    inversePrimary = Color(0xFF6B5B93),
    surfaceTint = GarlicPrimary,
    scrim = Color(0xCC000000),
    surfaceContainerLowest = Color(0xFF0A0A0E),
    surfaceContainerLow = Color(0xFF131318),
    surfaceContainer = GarlicSurface,
    surfaceContainerHigh = GarlicSurfaceVariant,
    surfaceContainerHighest = Color(0xFF262631),
)

@Composable
fun GarlicTransferTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = GarlicColorScheme,
        content = content,
    )
}
