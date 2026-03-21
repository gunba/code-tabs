param([string]$key = "{ESC}")
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
Add-Type -AssemblyName System.Windows.Forms

$proc = Get-Process -Name "claude-tabs" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($proc) {
    $hwnd = $proc.MainWindowHandle
    [Win32]::ShowWindow($hwnd, 9)
    [Win32]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait($key)
    Write-Host "Sent key: $key"
} else {
    Write-Host "claude-tabs not found"
}
