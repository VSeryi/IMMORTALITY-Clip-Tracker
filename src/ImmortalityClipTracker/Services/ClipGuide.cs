using ImmortalityClipTracker.Models;

namespace ImmortalityClipTracker.Services;

public static class ClipGuide
{
    public const int MaxClipId = 288;
    public const string FileName = "Immortality_Guide.csv";

    private sealed class Row
    {
        public required string Kind { get; init; }
        public required string Movie { get; init; }
        public required string Take { get; init; }
        public required string Date { get; init; }
        public required string Description { get; init; }
        public required List<string> Hints { get; init; }
        public bool IsSecret => Kind.StartsWith("Secret", StringComparison.Ordinal);
    }

    public static List<Clip> Build(Stream guide, SaveData save)
    {
        List<Row> rows = Align(Parse(guide), save.Watched);

        List<Clip> clips = new(rows.Count);
        for (int index = 0; index < rows.Count; index++)
        {
            Row row = rows[index];
            int id = index + 1;
            save.Watched.TryGetValue(id, out WatchedClip? watched);
            save.SecretHosts.TryGetValue(id, out int host);

            clips.Add(new Clip
            {
                Id = id,
                Watched = watched is not null,
                Secret = watched?.Secret ?? row.IsSecret,
                Views = watched?.Views ?? 0,
                Kind = row.Kind,
                Movie = string.IsNullOrEmpty(row.Movie) ? "Other" : row.Movie,
                Take = row.Take,
                Date = row.Date,
                Description = row.Description,
                HostClipId = host,
                Hints = row.Hints,
            });
        }

        Dictionary<int, string> labels = clips.ToDictionary(
            c => c.Id, c => string.IsNullOrEmpty(c.Date) ? c.Title : $"{c.Title} ({c.Date})");
        foreach (Clip clip in clips)
        {
            if (clip.HostClipId > 0 && labels.TryGetValue(clip.HostClipId, out string? label))
                clip.HostLabel = label;
        }
        return clips;
    }

    /// <summary>
    /// The guide lists a secret right after the clip it hides in, but the game hands
    /// out ClipIDs in a different local order, so about one row in twenty ends up
    /// describing its neighbour. IsSupernatural in the save is authoritative, so the
    /// rows get re-dealt to match that clip/secret pattern.
    /// </summary>
    private static List<Row> Align(List<Row> rows, IReadOnlyDictionary<int, WatchedClip> watched)
    {
        bool?[] wanted = new bool?[rows.Count];
        for (int i = 0; i < rows.Count; i++)
            wanted[i] = watched.TryGetValue(i + 1, out WatchedClip? clip) ? clip.Secret : null;

        int blanks = wanted.Count(w => w is null);
        if (blanks > 0)
        {
            // When every unwatched clip must be a secret (or must be a regular clip),
            // the arithmetic settles it and the whole list can be aligned.
            int outstanding = rows.Count(r => r.IsSecret) - wanted.Count(w => w == true);
            if (outstanding == 0 || outstanding == blanks)
            {
                bool value = outstanding != 0;
                for (int i = 0; i < wanted.Length; i++)
                    wanted[i] ??= value;
            }
        }

        bool[] used = new bool[rows.Count];
        Row?[] result = new Row?[rows.Count];
        for (int position = 0; position < rows.Count; position++)
        {
            if (wanted[position] is not bool want) continue;
            for (int index = 0; index < rows.Count; index++)
            {
                if (used[index] || rows[index].IsSecret != want) continue;
                result[position] = rows[index];
                used[index] = true;
                break;
            }
        }

        Queue<Row> spare = new(rows.Where((_, i) => !used[i]));
        for (int position = 0; position < result.Length; position++)
            result[position] ??= spare.Count > 0 ? spare.Dequeue() : rows[position];

        return [.. result.Select(r => r!)];
    }

    private static List<Row> Parse(Stream guide)
    {
        using StreamReader reader = new(guide);
        List<Row> rows = [];
        int lineNumber = 0;

        while (reader.ReadLine() is { } line)
        {
            // Two header rows: the first only groups the "Where To Find" columns.
            if (++lineNumber <= 2) continue;

            string[] cells = SplitCsv(line);
            if (cells.Length < 8 || !int.TryParse(Field(cells, 0), out int id)) continue;
            if (id is < 1 or > MaxClipId) continue;

            List<string> hints = [];
            for (int block = 0; block < 4; block++)
            {
                int start = 8 + (block * 4);
                string keyword = Field(cells, start);
                if (keyword.Length == 0) continue;

                string where = Location(Field(cells, start + 1), Field(cells, start + 2));
                string date = Field(cells, start + 3);
                if (date.Length > 0) where = $"{where} ({date})".Trim();
                hints.Add(where.Length > 0 ? $"{keyword} in {where}" : keyword);
            }

            rows.Add(new Row
            {
                Kind = Field(cells, 1),
                Movie = Field(cells, 2),
                Take = Field(cells, 3),
                Date = Field(cells, 4),
                Description = Field(cells, 7),
                Hints = hints,
            });
        }
        return rows;
    }

    private static string Location(string movie, string take) =>
        string.Join(' ', new[] { movie, take }.Where(p => p.Length > 0));

    private static string Field(string[] cells, int index)
    {
        if (index >= cells.Length) return string.Empty;
        string value = cells[index].Trim();
        return value == "-" ? string.Empty : value;
    }

    private static string[] SplitCsv(string line)
    {
        List<string> cells = [];
        System.Text.StringBuilder cell = new();
        bool quoted = false;

        for (int i = 0; i < line.Length; i++)
        {
            char c = line[i];
            if (quoted)
            {
                if (c != '"') { cell.Append(c); continue; }
                if (i + 1 < line.Length && line[i + 1] == '"') { cell.Append('"'); i++; continue; }
                quoted = false;
            }
            else if (c == '"') quoted = true;
            else if (c == ';') { cells.Add(cell.ToString()); cell.Clear(); }
            else cell.Append(c);
        }
        cells.Add(cell.ToString());
        return [.. cells];
    }
}
