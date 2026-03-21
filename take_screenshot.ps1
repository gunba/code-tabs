Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(1920,1080)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(0,0,0,0,$bmp.Size)
$bmp.Save("C:\Users\jorda\PycharmProjects\claude_tabs\screenshot1.png")
$g.Dispose()
$bmp.Dispose()
Write-Host "Screenshot saved"
