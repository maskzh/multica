//go:build windows

package util

import "syscall"

var (
	kernel32          = syscall.NewLazyDLL("kernel32.dll")
	user32            = syscall.NewLazyDLL("user32.dll")
	procAllocConsole  = kernel32.NewProc("AllocConsole")
	procGetConsoleWnd = kernel32.NewProc("GetConsoleWindow")
	procShowWindow    = user32.NewProc("ShowWindow")
)

const swHide = 0

// EnsureHiddenConsole guarantees the daemon owns a console that is not
// visible to the user. Every child process (git, cmd, etc.) inherits this
// hidden console automatically, so no per-call SysProcAttr gymnastics are
// needed.
func EnsureHiddenConsole() {
	if hwnd, _, _ := procGetConsoleWnd.Call(); hwnd != 0 {
		return // already have a console
	}
	if r, _, _ := procAllocConsole.Call(); r == 0 {
		return // AllocConsole failed
	}
	if hwnd, _, _ := procGetConsoleWnd.Call(); hwnd != 0 {
		procShowWindow.Call(hwnd, swHide)
	}
}
