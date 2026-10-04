using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;

namespace ImmortalityClipTracker;

/// <summary>
/// Serves the embedded web app over loopback. A custom URI scheme would avoid the
/// socket, but WebView2 only accepts those at environment-creation time, which
/// Photino does not expose. Real HTTP also keeps fetch() and relative URLs working
/// exactly as they do on the website.
/// </summary>
internal sealed class SiteServer : IDisposable
{
    private const string Prefix = "site.";

    private readonly Assembly _assembly = typeof(SiteServer).Assembly;
    private readonly HashSet<string> _files;
    private readonly TcpListener _listener;
    private readonly CancellationTokenSource _stopping = new();

    public int Port { get; }

    public SiteServer()
    {
        // RecursiveDir leaves Windows separators in the resource name; the URLs
        // that ask for them will always use the other kind.
        _files = [.. _assembly.GetManifestResourceNames()
            .Where(n => n.StartsWith(Prefix, StringComparison.Ordinal))
            .Select(n => n[Prefix.Length..].Replace('\\', '/'))];

        // Port 0 lets the OS pick a free one; loopback only, never the network.
        _listener = new TcpListener(IPAddress.Loopback, 0);
        _listener.Start();
        Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        _ = Task.Run(AcceptLoop);
    }

    private async Task AcceptLoop()
    {
        while (!_stopping.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await _listener.AcceptTcpClientAsync(_stopping.Token);
            }
            catch (OperationCanceledException) { return; }
            catch (SocketException) { return; }

            _ = Task.Run(() => Serve(client));
        }
    }

    private async Task Serve(TcpClient client)
    {
        try
        {
            using (client)
            {
                using NetworkStream stream = client.GetStream();
                string? target = await ReadRequestTarget(stream);
                if (target is null) return;

                // Exact-name lookup against the embedded list, so "../" cannot escape.
                string name = Uri.UnescapeDataString(target.Split('?', 2)[0]).TrimStart('/');
                if (name.Length == 0) name = "index.html";

                if (!_files.Contains(name))
                {
                    await Write(stream, "404 Not Found", "text/plain", Encoding.UTF8.GetBytes("Not found"));
                    return;
                }

                using Stream resource = _assembly.GetManifestResourceStream(Prefix + name.Replace('/', '\\'))
                    ?? _assembly.GetManifestResourceStream(Prefix + name)!;
                using MemoryStream body = new();
                await resource.CopyToAsync(body);
                await Write(stream, "200 OK", ContentType(name), body.ToArray());
            }
        }
        catch (IOException) { /* the webview hung up */ }
        catch (SocketException) { /* the webview hung up */ }
    }

    private static async Task<string?> ReadRequestTarget(NetworkStream stream)
    {
        byte[] buffer = new byte[8192];
        int read = await stream.ReadAsync(buffer);
        if (read <= 0) return null;

        string head = Encoding.ASCII.GetString(buffer, 0, read);
        int eol = head.IndexOf('\r');
        if (eol < 0) return null;

        string[] parts = head[..eol].Split(' ');
        return parts.Length >= 2 && parts[0] == "GET" ? parts[1] : null;
    }

    private static async Task Write(NetworkStream stream, string status, string type, byte[] body)
    {
        string head = $"HTTP/1.1 {status}\r\n"
            + $"Content-Type: {type}\r\n"
            + $"Content-Length: {body.Length}\r\n"
            + "Cache-Control: no-store\r\n"
            + "Connection: close\r\n\r\n";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(head));
        await stream.WriteAsync(body);
        await stream.FlushAsync();
    }

    private static string ContentType(string name) => Path.GetExtension(name) switch
    {
        ".html" => "text/html; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".js" => "text/javascript; charset=utf-8",
        ".json" => "application/json",
        ".webmanifest" => "application/manifest+json",
        ".png" => "image/png",
        ".txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };

    public void Dispose()
    {
        _stopping.Cancel();
        _listener.Stop();
        _stopping.Dispose();
    }
}
