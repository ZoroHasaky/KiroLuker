param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-RoundedRectanglePath {
  param(
    [System.Drawing.RectangleF]$Bounds,
    [float]$Radius
  )

  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $Radius * 2
  $arc = [System.Drawing.RectangleF]::new($Bounds.X, $Bounds.Y, $diameter, $diameter)
  $path.AddArc($arc, 180, 90)
  $arc.X = $Bounds.Right - $diameter
  $path.AddArc($arc, 270, 90)
  $arc.Y = $Bounds.Bottom - $diameter
  $path.AddArc($arc, 0, 90)
  $arc.X = $Bounds.X
  $path.AddArc($arc, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-KiroLukerIcon {
  param(
    [string]$Path,
    [int]$Size
  )

  $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $scale = $Size / 1024.0

    $background = New-RoundedRectanglePath `
      -Bounds ([System.Drawing.RectangleF]::new(72 * $scale, 72 * $scale, 880 * $scale, 880 * $scale)) `
      -Radius (210 * $scale)
    try {
      $purple = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#7C3AED'))
      try { $graphics.FillPath($purple, $background) } finally { $purple.Dispose() }
    } finally {
      $background.Dispose()
    }

    $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    try {
      # Geometric KL monogram: font-independent and readable at tray-icon sizes.
      $upperStroke = [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new(330 * $scale, 505 * $scale)
        [System.Drawing.PointF]::new(492 * $scale, 292 * $scale)
        [System.Drawing.PointF]::new(596 * $scale, 292 * $scale)
        [System.Drawing.PointF]::new(405 * $scale, 535 * $scale)
      )
      $graphics.FillPolygon($white, $upperStroke)
      $lowerStroke = [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new(332 * $scale, 510 * $scale)
        [System.Drawing.PointF]::new(416 * $scale, 466 * $scale)
        [System.Drawing.PointF]::new(604 * $scale, 732 * $scale)
        [System.Drawing.PointF]::new(496 * $scale, 732 * $scale)
      )
      $graphics.FillPolygon($white, $lowerStroke)
      # Draw the K stem last so its joins remain solid.
      $graphics.FillRectangle($white, 236 * $scale, 292 * $scale, 94 * $scale, 440 * $scale)
      $graphics.FillRectangle($white, 626 * $scale, 292 * $scale, 86 * $scale, 440 * $scale)
      $graphics.FillRectangle($white, 626 * $scale, 646 * $scale, 188 * $scale, 86 * $scale)
    } finally {
      $white.Dispose()
    }

    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory)) {
      New-Item -ItemType Directory -Path $directory | Out-Null
    }
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

$targets = @(
  @{ Path = 'src\renderer\src\assets\kiroluker-logo.png'; Size = 1024 },
  @{ Path = 'docs\logo.png'; Size = 1024 },
  @{ Path = 'build\icon.png'; Size = 1024 },
  @{ Path = 'resources\icons\mac-icon.png'; Size = 1024 },
  @{ Path = 'resources\icons\windows-icon.png'; Size = 716 },
  @{ Path = 'resources\tray\app.png'; Size = 716 },
  @{ Path = 'resources\tray\windows-icon.png'; Size = 716 }
)

foreach ($target in $targets) {
  New-KiroLukerIcon -Path (Join-Path $ProjectRoot $target.Path) -Size $target.Size
}

Write-Output "Generated $($targets.Count) KiroLuker icon assets."
