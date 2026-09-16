using System.Runtime.InteropServices;
using Avalonia;

namespace ImmortalityClipTracker;

internal static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        try
        {
            BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
        }
        catch (Exception error)
        {
            Fail(error);
        }
    }

    public static AppBuilder BuildAvaloniaApp() => AppBuilder.Configure<App>()
        .UsePlatformDetect()
        .WithInterFont()
        .LogToTrace();

    /// <summary>
    /// Without a window there is nowhere to report a startup failure, and the usual
    /// cause is the executable having been moved away from its native libraries.
    /// </summary>
    private static void Fail(Exception error)
    {
        // The load failure arrives wrapped in a TypeInitializationException.
        Exception? cause = error;
        while (cause is not null and not (DllNotFoundException or BadImageFormatException))
            cause = cause.InnerException;

        string message = cause is null
            ? error.ToString()
            : cause.Message + "\n\nThe app could not load one of its bundled graphics "
              + "libraries. Re-download it, and on macOS or Linux make sure the file is "
              + "still marked executable.";

        Console.Error.WriteLine(message);
        if (OperatingSystem.IsWindows())
            MessageBoxW(IntPtr.Zero, message, "IMMORTALITY clip tracker", 0x10);

        Environment.Exit(1);
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(IntPtr owner, string text, string caption, uint type);
}
