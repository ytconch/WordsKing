param(
    [switch]$Z1,
    [switch]$p,
    [Parameter(Position = 0)][string]$ArchivePath,
    [Parameter(Position = 1)][string]$EntryName
)

Add-Type -AssemblyName System.IO.Compression.FileSystem

if ($Z1 -and $ArchivePath) {
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        foreach ($entry in $archive.Entries) { [Console]::Out.WriteLine($entry.FullName) }
    } finally {
        $archive.Dispose()
    }
    exit 0
}

if ($p -and $ArchivePath -and $EntryName) {
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $entry = $archive.GetEntry($EntryName)
        if ($null -eq $entry) { exit 11 }
        $stream = $entry.Open()
        $buffer = New-Object System.IO.MemoryStream
        try {
            $stream.CopyTo($buffer)
            $bytes = $buffer.ToArray()
            [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
        } finally {
            $buffer.Dispose()
            $stream.Dispose()
        }
    } finally {
        $archive.Dispose()
    }
    exit 0
}

exit 2
