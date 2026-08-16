using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

internal static class Program
{
    private static void Log(string file, string line)
    {
        try { File.AppendAllText(file, line + Environment.NewLine); }
        catch (Exception) { }
    }

    private static int Main()
    {
        string node = @"D:\Apps\DevTools\java\Node.js\node.exe";
        string script = @"D:\workspace\downloader\desktop\host.mjs";
        string logFile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "host.log");
        try
        {
            // 路径无空格可直接传；如需通用可在运行时给 Arguments 加引号
            var psi = new ProcessStartInfo(node, script)
            {
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetDirectoryName(script) ?? AppDomain.CurrentDomain.BaseDirectory,
            };
            var p = Process.Start(psi);
            var si = Console.OpenStandardInput();
            var so = Console.OpenStandardOutput();
            var se = Console.OpenStandardError();
            var t1 = Task.Run(delegate
            {
                try { si.CopyTo(p.StandardInput.BaseStream); }
                catch (Exception) { }
                try { p.StandardInput.Close(); }
                catch (Exception) { }
            });
            var t2 = Task.Run(delegate
            {
                try { p.StandardOutput.BaseStream.CopyTo(so); so.Flush(); }
                catch (Exception) { }
            });
            var t3 = Task.Run(delegate
            {
                try { p.StandardError.BaseStream.CopyTo(se); se.Flush(); }
                catch (Exception) { }
            });
            p.WaitForExit();
            try { Task.WaitAll(new Task[] { t1, t2, t3 }, 8000); }
            catch (Exception) { }
            return p.ExitCode;
        }
        catch (Exception ex)
        {
            Log(logFile, "[launcher] " + ex.Message);
            return 1;
        }
    }
}
