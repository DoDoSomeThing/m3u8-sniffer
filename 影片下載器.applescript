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

-- scheme querystring 的 browser= 標籤 → macOS App 名（擴充偵測自己在哪個瀏覽器）
on browserAppName(btag)
	if btag is "edge" then return "Microsoft Edge"
	if btag is "brave" then return "Brave Browser"
	if btag is "opera" then return "Opera"
	if btag is "vivaldi" then return "Vivaldi"
	return "Google Chrome"
end browserAppName

on openWindow(browserApp)
	-- 有既有的影片下載器視窗就聚焦它，沒有才開新（避免每次下載都堆一個新視窗）
	-- Chromium 系（Edge/Brave/Opera/Vivaldi）AppleScript 字典同 Chrome，用 terms from 借字典動態 tell
	set found to false
	try
		using terms from application "Google Chrome"
			tell application browserApp
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
		end using terms from
		if not found then error "none"
	on error
		try
			-- app 模式：無網址列/分頁的獨立視窗
			do shell script "open -na " & quoted form of browserApp & " --args --app=" & quoted form of serverURL
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
	set btag to ""
	-- videodl://download?url=...&referer=...&name=...&browser=...（querystring 已由擴充 URL-encode）
	if this_URL contains "?" then
		set AppleScript's text item delimiters to "?"
		set qs to text item 2 of this_URL
		set AppleScript's text item delimiters to ""
		-- 解析 browser=（開回觸發下載的那個瀏覽器，不是永遠 Chrome）
		if qs contains "browser=" then
			set AppleScript's text item delimiters to "browser="
			set tmp to text item 2 of qs
			set AppleScript's text item delimiters to "&"
			set btag to text item 1 of tmp
			set AppleScript's text item delimiters to ""
		end if
		-- /pending GET 要帶共享 token（server 啟動時寫 ~/.videodl_token；擋惡意網頁 <img> 偽造）
		set tok to ""
		try
			set tok to do shell script "cat \"$HOME/.videodl_token\" 2>/dev/null | tr -d '\\n'"
		end try
		do shell script "export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; " & ¬
			"/usr/bin/curl -s " & quoted form of (serverURL & "/pending?" & qs & "&token=" & tok) & " >/dev/null 2>&1"
	end if
	openWindow(browserAppName(btag))
end open location
