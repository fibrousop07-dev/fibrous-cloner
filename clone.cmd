@echo off
rem  clone.cmd            -> opens the control panel (buttons)
rem  clone.cmd <url>      -> command-line clone + confirm
node "%~dp0sitecloner.mjs" %*
