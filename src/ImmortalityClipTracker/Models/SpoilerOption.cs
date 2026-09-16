namespace ImmortalityClipTracker.Models;

/// <summary>Ordered from most guarded to least; the UI compares with &gt;=.</summary>
public enum SpoilerLevel
{
    TotalOnly,
    MovieCounts,
    Numbers,
    Names,
    Everything,
}

public sealed record SpoilerOption(SpoilerLevel Level, string Label, string Detail)
{
    public static IReadOnlyList<SpoilerOption> All { get; } =
    [
        new(SpoilerLevel.TotalOnly, "Total only",
            "How many clips you still have to find. Nothing else."),
        new(SpoilerLevel.MovieCounts, "Per movie",
            "How many are left in each of the movies."),
        new(SpoilerLevel.Numbers, "Clip numbers",
            "Which numbers are missing. Secrets are flagged only once you have found them."),
        new(SpoilerLevel.Names, "Clip details",
            "Names, dates and what happens in every clip."),
        new(SpoilerLevel.Everything, "Everything",
            "Adds the route: which clip to match-cut or rewind from."),
    ];

    public override string ToString() => Label;
}
