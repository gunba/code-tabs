Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

$proc = Get-Process -Name "claude-tabs" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($proc) {
    $hwnd = $proc.MainWindowHandle
    [Win32]::ShowWindow($hwnd, 9)  # SW_RESTORE
    [Win32]::SetForegroundWindow($hwnd)
    Write-Host "Focused claude-tabs window (PID: $($proc.Id))"
} else {
    Write-Host "claude-tabs process not found"
}
