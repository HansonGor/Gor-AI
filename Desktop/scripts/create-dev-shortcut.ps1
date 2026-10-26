# 在 Windows 桌面创建「Gor 开发版」图标：双击运行 dev-launch.ps1（按需启动后端与 Web，再打开桌面端开发模式）。
# 图标用 Web/public/icon-512.png 加一个橙色「DEV」角标，和已安装的正式版区分；生成在 Desktop/out（已忽略提交）。
# 不放 %APPDATA%：实测放在那里时资源管理器读不出，桌面显示成空白图标。
# 用法：powershell -File Desktop\scripts\create-dev-shortcut.ps1（本机脚本，RemoteSigned 策略下可直接运行）
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$iconDir = Join-Path $root 'Desktop\out'
New-Item -ItemType Directory -Force $iconDir | Out-Null

# 先画 256px 母图：原图缩放 + 右下角圆角「DEV」角标
$size = 256
$source = [System.Drawing.Image]::FromFile((Join-Path $root 'Web\public\icon-512.png'))
$master = New-Object System.Drawing.Bitmap $size, $size
$graphics = [System.Drawing.Graphics]::FromImage($master)
$graphics.SmoothingMode = 'AntiAlias'
$graphics.InterpolationMode = 'HighQualityBicubic'
$graphics.TextRenderingHint = 'AntiAliasGridFit'
$graphics.DrawImage($source, 0, 0, $size, $size)
$badge = New-Object System.Drawing.Drawing2D.GraphicsPath
$x = 112; $y = 172; $w = 140; $h = 78; $r = 22
$badge.AddArc($x, $y, $r * 2, $r * 2, 180, 90)
$badge.AddArc($x + $w - $r * 2, $y, $r * 2, $r * 2, 270, 90)
$badge.AddArc($x + $w - $r * 2, $y + $h - $r * 2, $r * 2, $r * 2, 0, 90)
$badge.AddArc($x, $y + $h - $r * 2, $r * 2, $r * 2, 90, 90)
$badge.CloseFigure()
$graphics.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 245, 130, 32))), $badge)
$graphics.DrawPath((New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 6), $badge)
$font = New-Object System.Drawing.Font 'Segoe UI', 40, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = 'Center'; $format.LineAlignment = 'Center'
$graphics.DrawString('DEV', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF $x, $y, $w, $h), $format)
$graphics.Dispose(); $source.Dispose()

# 多尺寸 ICO：资源管理器按显示尺寸挑图，只放一张 256px PNG 时桌面会显示成空白图标。
# 256px 用 PNG，其余用 32 位 BMP（BITMAPINFOHEADER + 自下而上的 BGRA 像素 + 全零 AND 掩码，透明度取 alpha）。
function Get-IconImage([int]$edge) {
  $bitmap = New-Object System.Drawing.Bitmap $edge, $edge, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'
  $g.DrawImage($master, 0, 0, $edge, $edge)
  $g.Dispose()
  $stream = New-Object System.IO.MemoryStream
  if ($edge -eq 256) {
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  } else {
    $data = $bitmap.LockBits((New-Object System.Drawing.Rectangle 0, 0, $edge, $edge), 'ReadOnly', ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))
    $pixels = New-Object byte[] ($data.Stride * $edge)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pixels, 0, $pixels.Length)
    $bitmap.UnlockBits($data)
    $maskRow = [int]([math]::Ceiling($edge / 32) * 4)
    $out = New-Object System.IO.BinaryWriter $stream
    $out.Write([uint32]40); $out.Write([int32]$edge); $out.Write([int32]($edge * 2))
    $out.Write([uint16]1); $out.Write([uint16]32); $out.Write([uint32]0)
    $out.Write([uint32]($edge * $edge * 4 + $maskRow * $edge))
    $out.Write([int32]0); $out.Write([int32]0); $out.Write([uint32]0); $out.Write([uint32]0)
    for ($row = $edge - 1; $row -ge 0; $row--) { $out.Write($pixels, $row * $data.Stride, $edge * 4) }
    $out.Write((New-Object byte[] ($maskRow * $edge)))
    $out.Flush()
  }
  $bitmap.Dispose()
  , $stream.ToArray()
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$images = foreach ($edge in $sizes) { , (Get-IconImage $edge) }
$master.Dispose()
$iconPath = Join-Path $iconDir 'gor-dev.ico'
$writer = New-Object System.IO.BinaryWriter ([System.IO.File]::Create($iconPath))
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)   # ICONDIR：图标类型、张数
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $edge = $sizes[$i] % 256                                                                  # 0 表示 256px
  $writer.Write([byte]$edge); $writer.Write([byte]$edge); $writer.Write([byte]0); $writer.Write([byte]0)
  $writer.Write([uint16]1); $writer.Write([uint16]32)
  $writer.Write([uint32]$images[$i].Length); $writer.Write([uint32]$offset)
  $offset += $images[$i].Length
}
foreach ($image in $images) { $writer.Write([byte[]]$image) }
$writer.Close()

$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Gor 开发版.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = "-NoProfile -WindowStyle Hidden -File `"$(Join-Path $root 'Desktop\scripts\dev-launch.ps1')`""
$shortcut.WorkingDirectory = Join-Path $root 'Desktop'
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Description = 'Gor 桌面端开发版（自动启动后端与 Web 开发服务器）'
$shortcut.WindowStyle = 7
$shortcut.Save()
# 通知资源管理器刷新图标
Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\ie4uinit.exe') -ArgumentList '-show' -WindowStyle Hidden -ErrorAction SilentlyContinue
Write-Output "已创建：$shortcutPath"
