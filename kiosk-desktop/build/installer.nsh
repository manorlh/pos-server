; R2M POS for Windows - electron-builder NSIS include (picked up from build/ by name).
;
; Bridge mode (src/main/shell/mode.ts, pos-server docs/SPEC_KIOSK.md section 28): an installer saved
; under a name with "bridge" in it (the dashboard's download is R2M-POS-Windows-bridge-setup.exe)
; leaves %APPDATA%\R2M Kiosk\bridge.mode, which the app reads at start. One installer, one updater:
; the updates run the plain installer and the marker stays, so the mode stays.
; Per-user install (no admin): $APPDATA is the installing user's roaming folder.

!macro customInstall
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  StrLen $R1 "$EXEFILE"
  StrCpy $R0 0
  r2m_bridge_loop:
    IntCmp $R0 $R1 r2m_bridge_done 0 r2m_bridge_done
    StrCpy $R2 "$EXEFILE" 6 $R0
    StrCmp $R2 "bridge" r2m_bridge_found
    IntOp $R0 $R0 + 1
    Goto r2m_bridge_loop
  r2m_bridge_found:
    CreateDirectory "$APPDATA\R2M Kiosk"
    FileOpen $R3 "$APPDATA\R2M Kiosk\bridge.mode" w
    FileWrite $R3 "bridge"
    FileClose $R3
  r2m_bridge_done:
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
