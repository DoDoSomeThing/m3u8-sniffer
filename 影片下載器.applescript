-- 影片下載器（App 版）
-- 雙擊：啟動本地 server + 用 Chrome app 視窗開介面（無網址列，像獨立軟體）
-- videodl:// 喚起：擴充連不到 server 時開此協定 → 啟 server + 送下載 + 開進度視窗
property serverURL : "http://127.0.0.1:7654"

on serverUp()
	try
		do shell script "/usr/bin/curl -s " & serverURL & " >/dev/null 2>&1"
		return true
	on error
		return false
	end try
end serverUp

on ensureServer()
	if serverUp() then return
	set d to (system attribute "HOME") & "/Dropbox/AI_agent/600_Project/m3u8-sniffer"
	-- 開「看得到的」終端機視窗跑 server（前景）→ 當運作指示燈，Ctrl+C 或關視窗即停
	tell application "Terminal"
		do script "cd " & quoted form of d & " && export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH && echo '=== 影片下載器 運作中（Ctrl+C 或關閉此視窗即停止）===' && node server.js"
		activate
	end tell
	repeat 20 times
		if serverUp() then exit repeat
		delay 0.3
	end repeat
end ensureServer

on openWindow()
	-- 有既有的影片下載器視窗就聚焦它，沒有才開新（避免每次下載都堆一個新視窗）
	try
		tell application "Google Chrome"
			set found to false
			repeat with w in windows
				set ti to 0
				repeat with t in tabs of w
					set ti to ti + 1
					if (URL of t) starts with serverURL then
						set active tab index of w to ti
						set index of w to 1
						set found to true
						exit repeat
					end if
				end repeat
				if found then exit repeat
			end repeat
			activate
		end tell
		if not found then error "none"
	on error
		try
			-- Chrome app 模式：無網址列/分頁的獨立視窗
			do shell script "open -na 'Google Chrome' --args --app=" & quoted form of serverURL
		on error
			do shell script "open " & quoted form of serverURL
		end try
	end try
end openWindow

on run
	-- 雙擊：只在背景起 server，不開窗。視窗只在按下載（videodl:// 喚起）時才開。
	ensureServer()
end run

on open location this_URL
	ensureServer()
	-- videodl://download?url=...&referer=...&name=...（querystring 已由擴充 URL-encode）
	if this_URL contains "?" then
		set AppleScript's text item delimiters to "?"
		set qs to text item 2 of this_URL
		set AppleScript's text item delimiters to ""
		-- /pending GET 要帶共享 token（server 啟動時寫 ~/.videodl_token；擋惡意網頁 <img> 偽造）
		set tok to ""
		try
			set tok to do shell script "cat \"$HOME/.videodl_token\" 2>/dev/null | tr -d '\\n'"
		end try
		do shell script "export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; " & ¬
			"/usr/bin/curl -s " & quoted form of (serverURL & "/pending?" & qs & "&token=" & tok) & " >/dev/null 2>&1"
	end if
	openWindow()
end open location
