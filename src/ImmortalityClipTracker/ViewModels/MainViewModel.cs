using System.Collections.ObjectModel;
using System.Diagnostics;
using Avalonia.Platform;
using Avalonia.Platform.Storage;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using ImmortalityClipTracker.Models;
using ImmortalityClipTracker.Services;

namespace ImmortalityClipTracker.ViewModels;

public enum ClipFilter { Missing, Watched, All }

public sealed class MovieSummary
{
    public required string Name { get; init; }
    public required int Watched { get; init; }
    public required int Total { get; init; }

    /// <summary>The "no filter" row; its numbers are already in the header.</summary>
    public bool IsAll { get; init; }

    /// <summary>Missing secrets kept out of the counts by the secrets switch.</summary>
    public int HiddenSecrets { get; init; }
    public bool HasHiddenSecrets => HiddenSecrets > 0;

    public int Missing => Total - Watched;
    public double Progress => Total == 0 ? 0 : (double)Watched / Total;
    public string Tally => IsAll ? string.Empty : $"{Watched}/{Total}";
    public string Remaining => Missing == 0 ? "All found" : Missing.ToString();
    public string RemainingCaption => Missing switch
    {
        0 => string.Empty,
        1 => "clip left",
        _ => "clips left",
    };
    public bool HasCaption => RemainingCaption.Length > 0;
}

/// <summary>A clip as the list shows it, with the spoiler decisions already made.</summary>
public sealed class ClipRow
{
    private const string Blank = "\u2014";

    public required Clip Clip { get; init; }
    public required bool ShowDetails { get; init; }

    /// <summary>Marking an unwatched clip as a secret is itself a hint.</summary>
    public required bool ShowSecretMark { get; init; }

    public int Id => Clip.Id;
    public bool Watched => Clip.Watched;
    public bool SecretMark => Clip.Secret && ShowSecretMark;

    public string Title => ShowDetails ? Clip.Title : $"Clip {Clip.Id}";
    public string Meta => ShowDetails ? Clip.Subtitle : "details hidden at this setting";

    public string MovieText => Clip.Movie;
    public string TakeText => Or(Clip.Take);
    public string DateText => Or(Clip.Date);
    public string KindText => Clip.Kind;
    public string StatusText => Watched ? "Found" : "Still missing";
    public string ViewsText => Clip.Views == 1 ? "once" : $"{Clip.Views} times";
    public bool HasViews => Watched && Clip.Views > 0;

    private static string Or(string value) => string.IsNullOrEmpty(value) ? Blank : value;
}

public sealed partial class MainViewModel : ObservableObject
{
    private const string AllMovies = "All movies";

    private List<Clip> _all = [];

    /// <summary>Set while Recount rebuilds the movie list, whose selection would re-enter Refresh.</summary>
    private bool _rebuilding;

    [ObservableProperty] private string _savePath = string.Empty;
    [ObservableProperty] private string _status = "Looking for a save file\u2026";
    [ObservableProperty] private string _headline = string.Empty;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Complete), nameof(ShowHeaderTotals))]
    private bool _loaded;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowSelectedKind))]
    private ClipRow? _selected;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(EmptyMessage))]
    private ClipFilter _filter = ClipFilter.Missing;

    [ObservableProperty] private MovieSummary? _movie;
    [ObservableProperty] private bool _helpVisible;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowRoute), nameof(CanReveal))]
    private bool _revealed;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowSelectedDetails), nameof(CanRevealDetails), nameof(ShowSelectedKind))]
    private bool _revealedDetails;

    [ObservableProperty] private int _watchedCount;
    [ObservableProperty] private int _totalCount;
    [ObservableProperty] private double _progress;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(MissingCaption), nameof(Complete), nameof(ShowTease))]
    private int _missingCount;

    [ObservableProperty]
    [NotifyPropertyChangedFor(
        nameof(Level), nameof(ShowBrowser), nameof(ShowMovieBoard), nameof(ShowTotalBoard),
        nameof(ShowNames), nameof(ShowRoute), nameof(CanReveal), nameof(ShowHeaderTotals),
        nameof(ShowSelectedDetails), nameof(CanRevealDetails), nameof(ShowSelectedKind))]
    private SpoilerOption _spoilers = SpoilerOption.All[0];

    /// <summary>Independent of the spoiler level: drops secrets from the list and every count.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HiddenSecretsPending), nameof(ShowTease))]
    private bool _includeSecrets;

    public ObservableCollection<ClipRow> Clips { get; } = [];
    public ObservableCollection<MovieSummary> Movies { get; } = [];

    /// <summary>The movies alone; the header already carries the overall total.</summary>
    public ObservableCollection<MovieSummary> MovieBoard { get; } = [];

    public IReadOnlyList<SpoilerOption> SpoilerOptions => SpoilerOption.All;
    public IReadOnlyList<Credit> Credits => Models.Credits.All;
    public IReadOnlyList<string> Summary => Models.Credits.Summary;
    public string Disclaimer => Models.Credits.Disclaimer;
    public string Author => Models.Credits.Author;
    public string AuthorUrl => Models.Credits.AuthorUrl;
    public string SourceUrl => Models.Credits.SourceUrl;
    public IReadOnlyList<string> SaveFolders => SaveLocator.SearchedFolders();
    public string SteamCloudUrl => SaveLocator.SteamCloudUrl;

    public SpoilerLevel Level => Spoilers.Level;
    public bool ShowBrowser => Level >= SpoilerLevel.Numbers;
    public bool ShowMovieBoard => Level == SpoilerLevel.MovieCounts;
    public bool ShowTotalBoard => Level == SpoilerLevel.TotalOnly;
    public bool ShowNames => Level >= SpoilerLevel.Names;
    public bool ShowRoute => Level >= SpoilerLevel.Everything || Revealed;
    public bool CanReveal => ShowBrowser && !ShowRoute;

    /// <summary>The detail pane can show one clip's name and date without changing the level.</summary>
    public bool ShowSelectedDetails => ShowNames || RevealedDetails;
    public bool CanRevealDetails => ShowBrowser && !ShowSelectedDetails;

    /// <summary>Naming an unwatched clip as a secret is the same hint the list badge withholds.</summary>
    public bool ShowSelectedKind => ShowSelectedDetails || Selected is { Watched: true };

    /// <summary>Global numbers live in the header, except when they are the whole screen.</summary>
    public bool ShowHeaderTotals => Loaded && !ShowTotalBoard;

    public bool Complete => Loaded && MissingCount == 0;

    /// <summary>Secrets exist, are still unfound, and the switch is keeping them out of the counts.</summary>
    public bool HiddenSecretsPending => !IncludeSecrets && _all.Any(c => c.Secret && !c.Watched);

    /// <summary>Hiding secrets can make a partial run look finished; hint at it, do not spell it out.</summary>
    public bool ShowTease => Complete && HiddenSecretsPending;

    public string MissingCaption => MissingCount == 1 ? "clip still to find" : "clips still to find";

    public bool ListIsEmpty => ShowBrowser && Clips.Count == 0;

    public string EmptyMessage => Filter switch
    {
        ClipFilter.Missing => "Nothing left to find here.",
        ClipFilter.Watched => "You have not found any of these yet.",
        _ => "No clips here.",
    };

    /// <summary>Set by the view so the file picker can be shown.</summary>
    public IStorageProvider? Storage { get; set; }

    public void Initialise()
    {
        string? found = SaveLocator.Find();
        if (found is null)
        {
            Status = "No SaveGame.abr found";
            HelpVisible = true;
            return;
        }
        Load(found);
    }

    public void Load(string path)
    {
        try
        {
            SaveData save = SaveData.Read(path);
            using Stream guide = OpenGuide();
            _all = ClipGuide.Build(guide, save);

            SavePath = path;
            Loaded = true;
            HelpVisible = false;
            Status = $"Loaded {Path.GetFileName(path)}";
            Recount();
            Refresh();
            OnPropertyChanged(nameof(HiddenSecretsPending));
            OnPropertyChanged(nameof(ShowTease));
        }
        catch (Exception error)
        {
            Loaded = false;
            Status = $"Could not read that save: {error.Message}";
        }
    }

    private static Stream OpenGuide()
    {
        // A guide next to the app wins, so it can be updated without rebuilding.
        string local = Path.Combine(AppContext.BaseDirectory, ClipGuide.FileName);
        return File.Exists(local)
            ? File.OpenRead(local)
            : AssetLoader.Open(new Uri($"avares://ImmortalityClipTracker/Assets/{ClipGuide.FileName}"));
    }

    /// <summary>Totals follow the secrets switch, so every number stays consistent with the list.</summary>
    private void Recount()
    {
        List<Clip> scope = IncludeSecrets ? _all : [.. _all.Where(c => !c.Secret)];

        TotalCount = scope.Count;
        WatchedCount = scope.Count(c => c.Watched);
        MissingCount = TotalCount - WatchedCount;
        Progress = TotalCount == 0 ? 0 : (double)WatchedCount / TotalCount;

        string? previous = Movie?.Name;
        _rebuilding = true;
        Movies.Clear();
        MovieBoard.Clear();
        Movies.Add(new MovieSummary
        {
            Name = AllMovies, Watched = WatchedCount, Total = TotalCount, IsAll = true,
        });

        foreach (IGrouping<string, Clip> group in scope.GroupBy(c => c.Movie))
        {
            MovieSummary summary = new()
            {
                Name = group.Key,
                Watched = group.Count(c => c.Watched),
                Total = group.Count(),
                HiddenSecrets = IncludeSecrets
                    ? 0
                    : _all.Count(c => c.Movie == group.Key && c.Secret && !c.Watched),
            };
            Movies.Add(summary);
            MovieBoard.Add(summary);
        }

        Movie = Movies.FirstOrDefault(m => m.Name == previous) ?? Movies[0];
        _rebuilding = false;
    }

    private void Refresh()
    {
        if (_rebuilding) return;

        Headline = MissingCount == 0 ? "All found." : $"{MissingCount} still to find";

        Clips.Clear();
        if (ShowBrowser)
        {
            foreach (Clip clip in Query())
            {
                Clips.Add(new ClipRow
                {
                    Clip = clip,
                    ShowDetails = ShowNames,
                    ShowSecretMark = IncludeSecrets && (ShowNames || clip.Watched),
                });
            }
        }

        Selected = Clips.FirstOrDefault();
        OnPropertyChanged(nameof(ListIsEmpty));
    }

    private IEnumerable<Clip> Query()
    {
        IEnumerable<Clip> clips = IncludeSecrets ? _all : _all.Where(c => !c.Secret);

        clips = Filter switch
        {
            ClipFilter.Missing => clips.Where(c => !c.Watched),
            ClipFilter.Watched => clips.Where(c => c.Watched),
            _ => clips,
        };

        return Movie is { IsAll: false } movie
            ? clips.Where(c => c.Movie == movie.Name)
            : clips;
    }

    partial void OnFilterChanged(ClipFilter value) => Refresh();

    partial void OnMovieChanged(MovieSummary? value) => Refresh();

    partial void OnSelectedChanged(ClipRow? value)
    {
        Revealed = false;
        RevealedDetails = false;
    }

    partial void OnSpoilersChanged(SpoilerOption value)
    {
        Revealed = false;
        RevealedDetails = false;
        Refresh();
    }

    partial void OnIncludeSecretsChanged(bool value)
    {
        if (Loaded) Recount();
        Refresh();
    }

    [RelayCommand]
    private void Reveal() => Revealed = true;

    [RelayCommand]
    private void RevealDetails() => RevealedDetails = true;

    [RelayCommand]
    private void SetFilter(string value) =>
        Filter = Enum.TryParse(value, out ClipFilter parsed) ? parsed : ClipFilter.All;

    [RelayCommand]
    private void ShowMore() =>
        Spoilers = SpoilerOption.All[Math.Min((int)Level + 1, SpoilerOption.All.Count - 1)];

    [RelayCommand]
    private void ToggleHelp() => HelpVisible = !HelpVisible;

    [RelayCommand]
    private void CloseHelp() => HelpVisible = false;

    [RelayCommand]
    private void Reload()
    {
        if (string.IsNullOrEmpty(SavePath)) Initialise();
        else Load(SavePath);
    }

    [RelayCommand]
    private async Task OpenSaveAsync()
    {
        if (Storage is null) return;

        IReadOnlyList<IStorageFile> picked = await Storage.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = "Select SaveGame.abr",
            AllowMultiple = false,
            FileTypeFilter =
            [
                new FilePickerFileType("IMMORTALITY save") { Patterns = ["*.abr"] },
                FilePickerFileTypes.All,
            ],
        });

        if (picked.Count > 0 && picked[0].TryGetLocalPath() is { } path) Load(path);
    }

    [RelayCommand]
    private void OpenSaveFolder()
    {
        if (Path.GetDirectoryName(SavePath) is { Length: > 0 } folder && Directory.Exists(folder))
            Process.Start(new ProcessStartInfo(folder) { UseShellExecute = true });
    }

    [RelayCommand]
    private static void OpenUrl(string? url)
    {
        if (string.IsNullOrWhiteSpace(url)) return;
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
}
