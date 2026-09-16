namespace ImmortalityClipTracker.Services;

public static class SaveLocator
{
    public const string SteamCloudUrl =
        "https://store.steampowered.com/account/remotestorageapp/?appid=1350200";

    private const string SaveName = "SaveGame.abr";

    /// <summary>The folders searched, in order, for the "where is my save" help.</summary>
    public static IReadOnlyList<string> SearchedFolders() => [.. Roots()];

    /// <summary>A save dropped next to the app wins, then the game's own folders.</summary>
    public static string? Find()
    {
        foreach (string root in Roots())
        {
            if (!Directory.Exists(root)) continue;

            string? newest = null;
            DateTime stamp = DateTime.MinValue;
            foreach (string file in SafeEnumerate(root))
            {
                if (Path.GetFileName(Path.GetDirectoryName(file)) == "Thumbnails") continue;
                DateTime written = File.GetLastWriteTimeUtc(file);
                if (written <= stamp) continue;
                stamp = written;
                newest = file;
            }
            if (newest is not null) return newest;
        }
        return null;
    }

    private static IEnumerable<string> SafeEnumerate(string root)
    {
        try
        {
            return Directory.EnumerateFiles(root, SaveName, new EnumerationOptions
            {
                RecurseSubdirectories = true,
                IgnoreInaccessible = true,
                MaxRecursionDepth = 8,
            });
        }
        catch (IOException)
        {
            return [];
        }
        catch (UnauthorizedAccessException)
        {
            return [];
        }
    }

    private static IEnumerable<string> Roots()
    {
        yield return AppContext.BaseDirectory;

        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (OperatingSystem.IsWindows())
        {
            yield return Path.Combine(home, "AppData", "LocalLow",
                "Half Mermaid Productions", "Immortality");
        }
        else if (OperatingSystem.IsMacOS())
        {
            yield return Path.Combine(home, "Library", "Application Support",
                "Half Mermaid Productions", "Immortality");
            yield return Path.Combine(home, "Library", "Application Support",
                "unity.Half Mermaid Productions.Immortality");
        }
        else
        {
            yield return Path.Combine(home, ".config", "unity3d",
                "Half Mermaid Productions", "Immortality");
            string[] steamRoots =
            [
                Path.Combine(home, ".steam", "steam"),
                Path.Combine(home, ".local", "share", "Steam"),
                Path.Combine(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam"),
            ];
            foreach (string steam in steamRoots)
            {
                yield return Path.Combine(steam, "steamapps", "compatdata", "1350200", "pfx",
                    "drive_c", "users", "steamuser", "AppData", "LocalLow",
                    "Half Mermaid Productions", "Immortality");
            }
        }

        yield return Path.Combine(home, "Downloads");
    }
}
