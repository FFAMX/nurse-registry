' ============================================================
'  Nurse Registry System - Silent Start (background)
'
'  Double-click to start the service WITHOUT a console window.
'  To stop it, double-click 停止服务.bat .
'
'  IMPORTANT: keep this file ASCII-only. Non-ASCII bytes in VBS
'  can be mis-decoded depending on the system code page and
'  break string parsing. All messages come from Node instead.
'
'  Logs:
'    %TEMP%\nurse-registry.log
'    %TEMP%\nurse-registry.err.log
' ============================================================

Option Explicit

Dim fso, shell, root, nodeExe, logFile, errFile, cmd

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' 本脚本所在目录
root = fso.GetParentFolderName(WScript.ScriptFullName)

' ---- 定位 node.exe：便携版优先，其次系统 PATH ----
nodeExe = ""

If fso.FileExists(root & "\portable-node\node.exe") Then
    nodeExe = root & "\portable-node\node.exe"
End If

If nodeExe = "" Then
    nodeExe = ResolveFromPath("node.exe")
End If

If nodeExe = "" Then
    MsgBox "Node.js not found." & vbCrLf & vbCrLf & _
           "Expected file:" & vbCrLf & _
           "    portable-node\node.exe" & vbCrLf & vbCrLf & _
           "Or install Node.js 18+ from https://nodejs.org/", _
           vbCritical, "Nurse Registry"
    WScript.Quit 1
End If

' ---- 启动器脚本 ----
Dim launchScript
launchScript = root & "\scripts\launch.js"

If Not fso.FileExists(launchScript) Then
    MsgBox "Missing file: scripts\launch.js" & vbCrLf & _
           "Please make sure the project files are complete.", _
           vbCritical, "Nurse Registry"
    WScript.Quit 1
End If

logFile = shell.ExpandEnvironmentStrings("%TEMP%") & "\nurse-registry.log"
errFile = shell.ExpandEnvironmentStrings("%TEMP%") & "\nurse-registry.err.log"

' 0 = 隐藏窗口, False = 不等待
cmd = """" & nodeExe & """ """ & launchScript & """"
shell.CurrentDirectory = root
shell.Run cmd, 0, False

' ---- 等待并验证端口是否真的起来了 ----
Dim ok, waited
ok = False

For waited = 1 To 30
    WScript.Sleep 1000
    If PortIsListening(3000) Then
        ok = True
        Exit For
    End If
Next

If ok Then
    MsgBox "Service started successfully." & vbCrLf & vbCrLf & _
           "  Admin   http://localhost:3000/admin" & vbCrLf & _
           "  Portal  http://localhost:3000/login.html" & vbCrLf & vbCrLf & _
           "Account: admin" & vbCrLf & _
           "(password: see .env / startup log)" & vbCrLf & vbCrLf & _
           "To stop: double-click 停止服务.bat", _
           vbInformation, "Nurse Registry"
Else
    Dim detail
    detail = ReadTail(errFile, 1200)
    If detail = "" Then detail = ReadTail(logFile, 1200)
    If detail = "" Then detail = "(no log output)"

    MsgBox "Service did NOT start within 30 seconds." & vbCrLf & vbCrLf & _
           "Log tail:" & vbCrLf & detail & vbCrLf & vbCrLf & _
           "Try: double-click 诊断.bat to see what is wrong.", _
           vbExclamation, "Nurse Registry"
End If

' ============================================================
'  辅助函数
' ============================================================

' 用 where 在 PATH 里查找可执行文件
Function ResolveFromPath(exeName)
    Dim exec, out
    ResolveFromPath = ""
    On Error Resume Next
    Set exec = shell.Exec("cmd /c where " & exeName)
    If Err.Number <> 0 Then
        Err.Clear
        Exit Function
    End If
    out = exec.StdOut.ReadAll
    If Len(Trim(out)) > 0 Then
        ResolveFromPath = Trim(Split(out, vbCrLf)(0))
    End If
    On Error GoTo 0
End Function

' 通过 netstat 判断端口是否处于 LISTENING
Function PortIsListening(port)
    Dim exec, out, lines, i, needle
    PortIsListening = False

    On Error Resume Next
    Set exec = shell.Exec("cmd /c netstat -ano -p TCP")
    If Err.Number <> 0 Then
        Err.Clear
        Exit Function
    End If
    out = exec.StdOut.ReadAll
    On Error GoTo 0

    needle = ":" & port & " "
    lines = Split(out, vbCrLf)

    For i = 0 To UBound(lines)
        If InStr(lines(i), needle) > 0 And InStr(lines(i), "LISTENING") > 0 Then
            PortIsListening = True
            Exit Function
        End If
    Next
End Function

' 读取文件末尾若干字符，用于错误提示
Function ReadTail(filePath, maxChars)
    Dim ts, content
    ReadTail = ""

    On Error Resume Next
    If Not fso.FileExists(filePath) Then
        Err.Clear
        Exit Function
    End If
    Set ts = fso.OpenTextFile(filePath, 1)
    content = ts.ReadAll
    ts.Close
    On Error GoTo 0

    If Len(content) > maxChars Then
        ReadTail = "..." & Right(content, maxChars)
    Else
        ReadTail = content
    End If
End Function
