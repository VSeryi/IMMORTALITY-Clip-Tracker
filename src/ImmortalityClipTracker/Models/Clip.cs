namespace ImmortalityClipTracker.Models;

/// <summary>One entry of the clip guide, already matched against the save.</summary>
public sealed class Clip
{
    public required int Id { get; init; }
    public required bool Watched { get; init; }
    public required bool Secret { get; init; }
    public required int Views { get; init; }

    /// <summary>Clip, Secret, or Secret1..Secret5 for nested rewinds.</summary>
    public required string Kind { get; init; }

    public required string Movie { get; init; }
    public required string Take { get; init; }
    public required string Date { get; init; }
    public required string Description { get; init; }

    /// <summary>For monologue secrets: the clip this one hides in, per this save.</summary>
    public required int HostClipId { get; init; }

    public string HostLabel { get; set; } = string.Empty;
    public required IReadOnlyList<string> Hints { get; init; }

    public string Title => string.IsNullOrEmpty(Take) ? Movie : $"{Movie} {Take}";

    public string Subtitle =>
        string.Join("  \u00b7  ", new[] { Date, Description }.Where(p => !string.IsNullOrEmpty(p)));

    private int RewindDepth
    {
        get
        {
            string digits = new([.. Kind.Where(char.IsDigit)]);
            return digits.Length > 0 ? int.Parse(digits) : 1;
        }
    }

    /// <summary>The steps that actually lead to this clip.</summary>
    public IReadOnlyList<string> HowToFind
    {
        get
        {
            if (!Secret)
            {
                return Hints.Count > 0
                    ? [.. Hints.Select(h => $"Match-cut on {h}")]
                    : ["No route recorded in the guide."];
            }

            if (HostClipId > 0)
            {
                string host = string.IsNullOrEmpty(HostLabel) ? string.Empty : $" \u2013 {HostLabel}";
                return [$"Rewind clip #{HostClipId}{host}"];
            }

            if (string.IsNullOrEmpty(Take) && string.IsNullOrEmpty(Date))
                return [$"Hidden inside the {Movie} clips"];

            string where = string.IsNullOrEmpty(Date) ? Title : $"{Title} ({Date})";
            return RewindDepth > 1
                ? [$"Rewind {where}", $"Keep rewinding \u2013 it is {RewindDepth} levels deep"]
                : [$"Rewind {where}"];
        }
    }
}
