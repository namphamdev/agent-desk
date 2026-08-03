@echo off
set SH_PATH="C:\Program Files\Git\bin\sh.exe"
if not exist %SH_PATH% set SH_PATH="%USERPROFILE%\AppData\Local\Programs\Git\bin\sh.exe"
%SH_PATH% "%~dp0fake-claude.sh" %*
