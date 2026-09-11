using System;
using System.IO;
using System.IO.Compression;

public static class UnzipShim
{
    public static int Main(string[] args)
    {
        if (args.Length < 2) return 2;
        string mode = args[0];
        string archive = args[1];

        using (ZipArchive zip = ZipFile.OpenRead(archive))
        {
            if (mode == "-Z1")
            {
                foreach (ZipArchiveEntry entry in zip.Entries)
                    Console.Out.WriteLine(entry.FullName);
                return 0;
            }

            if (mode == "-p" && args.Length >= 3)
            {
                string requested = args[2];
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    if (!String.Equals(entry.FullName, requested, StringComparison.Ordinal))
                        continue;
                    using (Stream input = entry.Open())
                    using (Stream output = Console.OpenStandardOutput())
                    {
                        input.CopyTo(output);
                        output.Flush();
                    }
                    return 0;
                }
                return 11;
            }
        }

        return 2;
    }
}
