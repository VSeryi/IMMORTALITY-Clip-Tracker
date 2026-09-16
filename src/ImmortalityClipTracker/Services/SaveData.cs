using System.Formats.Nrbf;

namespace ImmortalityClipTracker.Services;

public sealed record WatchedClip(int Views, bool Secret);

/// <summary>
/// SaveGame.abr is a .NET BinaryFormatter (MS-NRBF) stream, so the framework can
/// read it directly.
/// </summary>
public sealed class SaveData
{
    public required string Path { get; init; }
    public required IReadOnlyDictionary<int, WatchedClip> Watched { get; init; }

    /// <summary>Monologue secret id -> the clip it hides in. Randomised per playthrough.</summary>
    public required IReadOnlyDictionary<int, int> SecretHosts { get; init; }

    public static SaveData Read(string path)
    {
        using FileStream stream = File.OpenRead(path);
        if (NrbfDecoder.Decode(stream) is not ClassRecord root)
            throw new InvalidDataException("This does not look like an IMMORTALITY save.");

        ClassRecord game = root.GetClassRecord("Game")
            ?? throw new InvalidDataException("The save has no Game section.");

        Dictionary<int, WatchedClip> watched = [];
        ClassRecord? history = game.GetClassRecord("ViewHistory");
        if (history?.GetArrayRecord("_items") is SZArrayRecord<SerializationRecord> items)
        {
            SerializationRecord?[] entries = items.GetArray();
            int count = Math.Min(history.GetInt32("_size"), entries.Length);
            for (int i = 0; i < count; i++)
            {
                if (entries[i] is not ClassRecord viewed) continue;
                watched[viewed.GetInt32("ClipID")] = new WatchedClip(
                    viewed.GetInt32("Views"),
                    viewed.GetBoolean("IsSupernatural"));
            }
        }

        Dictionary<int, int> hosts = [];
        ClassRecord? assigned = game.GetClassRecord("AssignedSecrets");
        if (assigned?.GetArrayRecord("KeyValuePairs") is SZArrayRecord<SerializationRecord> pairs)
        {
            foreach (SerializationRecord? entry in pairs.GetArray())
            {
                if (entry is ClassRecord pair)
                    hosts[pair.GetInt32("key")] = pair.GetInt32("value");
            }
        }

        return new SaveData { Path = path, Watched = watched, SecretHosts = hosts };
    }
}
