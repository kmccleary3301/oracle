$signature = @'
[DllImport("user32.dll")]
public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

[DllImport("user32.dll")]
public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
'@

Add-Type -Name NativeMethods -Namespace Win32 -MemberDefinition $signature -ErrorAction SilentlyContinue

Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "chrome.exe" -and $_.CommandLine -like "*--remote-debugging-port=33791*" } |
  Select-Object -First 1 |
  ForEach-Object {
    $process = Get-Process -Id $_.ProcessId
    [Win32.NativeMethods]::ShowWindowAsync($process.MainWindowHandle, 9) | Out-Null
    [Win32.NativeMethods]::SetWindowPos($process.MainWindowHandle, [IntPtr]::Zero, 10, 10, 1280, 720, 0x0040) | Out-Null
    Write-Output ("shown " + $_.ProcessId)
  }
