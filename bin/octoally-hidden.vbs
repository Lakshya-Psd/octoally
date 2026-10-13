' OctoAlly hidden launcher (Windows).
' Runs the OctoAlly CLI with no console window - used by the login auto-start
' entry that "octoally install-service" writes to
' HKCU\Software\Microsoft\Windows\CurrentVersion\Run.
'
' Usage: wscript.exe //B //Nologo octoally-hidden.vbs [path\to\node.exe] [command ...]
'   node.exe defaults to "node" (PATH lookup); command defaults to "start".
' CLI output is appended to <installDir>\logs\autostart.log.

Option Explicit

Dim fso, sh, binDir, installDir, cli, logDir, logFile, nodeExe, cliArgs, i, cmd

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

binDir = fso.GetParentFolderName(WScript.ScriptFullName)
installDir = fso.GetParentFolderName(binDir)
cli = fso.BuildPath(binDir, "octoally-win.mjs")
logDir = fso.BuildPath(installDir, "logs")
logFile = fso.BuildPath(logDir, "autostart.log")

If Not fso.FolderExists(logDir) Then
  On Error Resume Next
  fso.CreateFolder logDir
  On Error GoTo 0
End If

nodeExe = "node"
If WScript.Arguments.Count > 0 Then
  If Len(WScript.Arguments(0)) > 0 Then nodeExe = WScript.Arguments(0)
End If

cliArgs = ""
For i = 1 To WScript.Arguments.Count - 1
  cliArgs = cliArgs & " " & Q(WScript.Arguments(i))
Next
If cliArgs = "" Then cliArgs = " start"

' cmd /s strips the outer quotes, leaving: "node" "cli" start >> "log" 2>&1
cmd = "cmd.exe /d /s /c """ & Q(nodeExe) & " " & Q(cli) & cliArgs & " >> " & Q(logFile) & " 2>&1"""

' 0 = hidden window, False = do not wait
sh.Run cmd, 0, False

Function Q(s)
  Q = """" & s & """"
End Function
