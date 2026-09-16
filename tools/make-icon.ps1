Add-Type -AssemblyName System.Drawing

$out = Join-Path $PSScriptRoot '..\src\ImmortalityClipTracker\Assets'
$amber = [Drawing.Color]::FromArgb(216, 163, 74)

function New-Reel([int]$size) {
    $bmp = New-Object Drawing.Bitmap $size, $size
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([Drawing.Color]::Transparent)

    $k = $size / 256.0
    $c = 128.0 * $k

    $path = New-Object Drawing.Drawing2D.GraphicsPath
    $path.FillMode = [Drawing.Drawing2D.FillMode]::Alternate

    # reel plate, centre hub, then six sprocket holes punched through it
    $r = 124.0 * $k
    $path.AddEllipse(($c - $r), ($c - $r), (2 * $r), (2 * $r))
    $r = 34.0 * $k
    $path.AddEllipse(($c - $r), ($c - $r), (2 * $r), (2 * $r))

    $hole = 21.0 * $k
    $ring = 84.0 * $k
    foreach ($step in 0..5) {
        $a = [Math]::PI / 2 + ($step * [Math]::PI / 3)
        $hx = $c + $ring * [Math]::Cos($a)
        $hy = $c - $ring * [Math]::Sin($a)
        $path.AddEllipse(($hx - $hole), ($hy - $hole), (2 * $hole), (2 * $hole))
    }

    $brush = New-Object Drawing.SolidBrush $amber
    $g.FillPath($brush, $path)
    $brush.Dispose(); $path.Dispose(); $g.Dispose()
    return $bmp
}

# Windows renders small icons more reliably from classic DIB frames than PNG ones.
function ConvertTo-Dib($bmp) {
    $w = $bmp.Width; $h = $bmp.Height
    $ms = New-Object IO.MemoryStream
    $bw = New-Object IO.BinaryWriter $ms
    $bw.Write([uint32]40); $bw.Write([int32]$w); $bw.Write([int32]($h * 2))
    $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]0)
    $bw.Write([uint32]($w * $h * 4))
    $bw.Write([int32]0); $bw.Write([int32]0); $bw.Write([uint32]0); $bw.Write([uint32]0)

    for ($y = $h - 1; $y -ge 0; $y--) {
        for ($x = 0; $x -lt $w; $x++) {
            $c = $bmp.GetPixel($x, $y)
            $bw.Write([byte]$c.B); $bw.Write([byte]$c.G)
            $bw.Write([byte]$c.R); $bw.Write([byte]$c.A)
        }
    }

    $stride = [math]::Floor(($w + 31) / 32) * 4
    $bw.Write((New-Object byte[] ($stride * $h)))
    $bw.Flush()
    return $ms.ToArray()
}

function ConvertTo-Png($bmp) {
    $ms = New-Object IO.MemoryStream
    $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
    return $ms.ToArray()
}

$png = New-Reel 256
$png.Save((Join-Path $out 'icon.png'), [Drawing.Imaging.ImageFormat]::Png)
$png.Dispose()

$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$frames = foreach ($s in $sizes) {
    $bmp = New-Reel $s
    $data = if ($s -ge 128) { ConvertTo-Png $bmp } else { ConvertTo-Dib $bmp }
    $bmp.Dispose()
    , $data
}

$ico = New-Object IO.MemoryStream
$w = New-Object IO.BinaryWriter $ico
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$frames.Count)
$offset = 6 + (16 * $frames.Count)
for ($i = 0; $i -lt $frames.Count; $i++) {
    $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
    $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$frames[$i].Length); $w.Write([uint32]$offset)
    $offset += $frames[$i].Length
}
foreach ($frame in $frames) { $ico.Write($frame, 0, $frame.Length) }
$w.Flush()
[IO.File]::WriteAllBytes((Join-Path $out 'icon.ico'), $ico.ToArray())
$w.Dispose()

'icon.ico and icon.png written'
