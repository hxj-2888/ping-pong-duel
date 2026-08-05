' Ping-Pong Duel - Desktop App Launcher (no console window)
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "node ""desktop-launcher.js""", 0, False
