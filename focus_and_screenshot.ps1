Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
}
"@
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Focus claude-tabs
$proc = Get-Process -Name "claude-tabs" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($proc) {
    $hwnd = $proc.MainWindowHandle
    [Win32]::ShowWindow($hwnd, 5)  # SW_SHOW
    Start-Sleep -Milliseconds 200
    [Win32]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 1000

    # Take screenshot
    $bmp = New-Object System.Drawing.Bitmap(1920,1080)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen(0,0,0,0,$bmp.Size)
    $bmp.Save("C:\Users\jorda\PycharmProjects\claude_tabs\screenshot1.png")
    $g.Dispose()
    $bmp.Dispose()
    Write-Host "Done - focused and screenshotted"
} else {
    Write-Host "claude-tabs not found"
}
