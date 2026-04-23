$signature = @'
[DllImport("user32.dll")]
public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
'@

Add-Type -Name NativeMethods -Namespace Win32 -MemberDefinition $signature -ErrorAction SilentlyContinue

Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "chrome.exe" -and $_.CommandLine -like "*--remote-debugging-port=33791*" } |
  ForEach-Object {
    $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    if ($process -and $process.MainWindowHandle -ne 0) {
      [Win32.NativeMethods]::ShowWindowAsync($process.MainWindowHandle, 6) | Out-Null
      Write-Output ("minimized " + $_.ProcessId)
    }
  }
