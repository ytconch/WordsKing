Add-Type -AssemblyName System.IO.Compression.FileSystem
$Mode = $args[0]
$Archive = $args[1]
$Entry = $args[2]
$zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
try {
  if ($Mode -eq '-Z1') {
    foreach ($item in $zip.Entries) {
      [Console]::Out.WriteLine($item.FullName)
    }
    exit 0
  }

  if ($Mode -eq '-p') {
    $item = $zip.Entries | Where-Object { $_.FullName -eq $Entry } | Select-Object -First 1
    if ($null -eq $item) { exit 11 }
    $inputStream = $item.Open()
    try {
      $outputStream = [Console]::OpenStandardOutput()
      $inputStream.CopyTo($outputStream)
      $outputStream.Flush()
    } finally {
      $inputStream.Dispose()
    }
    exit 0
  }

  exit 2
} finally {
  $zip.Dispose()
}
