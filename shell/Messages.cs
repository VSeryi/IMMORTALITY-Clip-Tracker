using System.Text.Json.Serialization;

namespace ImmortalityClipTracker;

/// <summary>What the page asks the shell to do.</summary>
internal sealed record Request
{
    [JsonPropertyName("cmd")] public string? Cmd { get; init; }
    [JsonPropertyName("path")] public string? Path { get; init; }
}

/// <summary>The save, or why it could not be produced.</summary>
internal sealed record Reply
{
    [JsonPropertyName("ok")] public bool Ok { get; init; }
    [JsonPropertyName("cancelled")] public bool Cancelled { get; init; }
    [JsonPropertyName("path")] public string? Path { get; init; }
    [JsonPropertyName("data")] public string? Data { get; init; }
    [JsonPropertyName("error")] public string? Error { get; init; }
    [JsonPropertyName("hint")] public string? Hint { get; init; }
}

// Source-generated so the shell can publish trimmed; reflection-based
// serialisation would be stripped out and fail at runtime.
[JsonSourceGenerationOptions(DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(Request))]
[JsonSerializable(typeof(Reply))]
internal sealed partial class ShellJson : JsonSerializerContext;
