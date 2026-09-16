namespace ImmortalityClipTracker.Models;

public sealed record Credit(string Gave, string Detail, string Url)
{
    public string? Derived { get; init; }
    public string? DerivedUrl { get; init; }
    public bool HasDerived => DerivedUrl is not null;
}

public static class Credits
{
    /// <summary>One paragraph per entry so the About panel can breathe.</summary>
    public static IReadOnlyList<string> Summary { get; } =
    [
        "IMMORTALITY never tells you which clips you have already seen. There is no list, no counter, and no way to know what is left.",
        "This app works it out from your own save file. Nothing is uploaded, and nothing ever leaves your machine.",
        "It exists because other people solved the hard parts first and published what they found.",
    ];

    public static IReadOnlyList<Credit> All { get; } =
    [
        new("The clip list",
            "A spreadsheet of every clip with its take, its date, and the objects you can "
            + "match-cut from. It is the guide this app ships with.",
            "https://steamcommunity.com/sharedfiles/filedetails/?id=3342793414")
        {
            Derived = "Built in turn on the community completionist guide",
            DerivedUrl = "https://steamcommunity.com/sharedfiles/filedetails/?id=2860754029",
        },

        new("Reading the save",
            "Worked out that SaveGame.abr holds your view history, and showed how to get the "
            + "watched clip IDs out of it. This app does the same thing directly, with no "
            + "online save editor in the middle.",
            "https://steamcommunity.com/sharedfiles/filedetails/?id=3731545899"),

        new("The idea",
            "The original \u201cwhich videos have I actually seen?\u201d counter, and the reason "
            + "any of this exists.",
            "https://steamcommunity.com/sharedfiles/filedetails/?id=3204009205"),
    ];

    public const string Author = "XxSeRyIxX";
    public const string AuthorUrl = "https://steamcommunity.com/id/xxseryixx/";
    public const string SourceUrl = "https://github.com/VSeryi/IMMORTALITY-Clip-Tracker";

    public const string Disclaimer =
        "Free software under the GNU AGPL v3. Not affiliated with Half Mermaid or Sam Barlow.";
}
