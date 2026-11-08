/**
 * Console messages for the launcher, in the three supported languages.
 *
 * The launcher picks the language from the saved preference (config/settings.json)
 * resolved against the operating system locale, so the console uses the same
 * language the user chose in the web console on their next start.
 */
const MESSAGES = {
  'zh-CN': {
    productLine: '直播记忆 · 本地优先的直播记忆系统',
    starting: '正在启动 LiveMemory…',
    checkingEnvironment: '正在检查运行环境…',
    environmentOk: '运行环境检查通过',
    dataDir: '数据目录',
    consoleUrl: '控制台地址',
    logFile: '日志目录',
    recording: '记录状态',
    quitting: '退出方式',
    quitHint: '按 Ctrl+C 停止记录并安全退出',
    openingBrowser: '正在打开默认浏览器…',
    browserOpened: '已请求系统打开默认浏览器',
    browserFailed: '无法自动打开浏览器，请手动复制上面的控制台地址到浏览器中打开',
    alreadyRunning: 'LiveMemory 已在运行，本次不会重复启动。',
    alreadyRunningUrl: '已打开正在运行的控制台：',
    portConflict: '端口被占用，已自动改用其他本地端口。',
    databaseError: '数据库无法打开或初始化失败。',
    dataDirUnwritable: '数据目录不可写入：{path}',
    dataDirHint: '请检查该目录的权限，或使用 --data-dir 指定另一个可写目录。',
    unsupportedNode: '需要 Node.js {expected} 或更高版本，当前为 {actual}。',
    sqliteUnavailable: '当前 Node.js 缺少内置 SQLite 支持（node:sqlite）。请升级到 Node.js 22.5 或更高版本。',
    lockFailed: '无法创建单实例锁文件：{path}',
    shuttingDown: '正在停止记录并安全退出…',
    exited: '已安全退出 LiveMemory。',
    stoppedRecording: '记录已停止，数据已写入磁盘。',
    pressEnter: '按 Enter 键关闭此窗口…',
    errorPrefix: '错误',
    fatalTitle: 'LiveMemory 无法启动',
    statusIdle: '空闲（未在记录）',
    statusStarting: '正在连接…',
    statusRecording: '正在记录：{title}',
    statusRecordingStats: '已收到 {messages} 条消息 · {viewers} 位观众',
    statusConnected: '已连接',
    statusFailed: '直播连接失败：{reason}',
    statusAuth: '登录状态失效，需要重新授权',
    statusStopped: '记录已停止',
    helpTitle: 'LiveMemory 启动选项',
    helpBody: [
      '  --no-open            启动后不自动打开浏览器',
      '  --port <端口>        指定本地端口（默认 47800，被占用时自动顺延）',
      '  --data-dir <路径>    指定用户数据目录',
      '  --lang <语言>        zh-CN | ja | en',
      '  --version            显示版本号',
      '  --help               显示此帮助'
    ].join('\n'),
    recoveredSessions: '检测到 {count} 个未正常结束的直播场次，已标记为“已中断”。',
    simulatedNote: '当前为模拟直播（用于验证记录流程），不是真实平台数据。',
    webHint: '提示：关闭浏览器不会停止记录；请在命令行按 Ctrl+C 结束。'
  },
  ja: {
    productLine: 'ローカル優先の配信記録システム',
    starting: 'LiveMemory を起動しています…',
    checkingEnvironment: '実行環境を確認しています…',
    environmentOk: '実行環境の確認が完了しました',
    dataDir: 'データフォルダー',
    consoleUrl: 'コンソール URL',
    logFile: 'ログフォルダー',
    recording: '記録状態',
    quitting: '終了方法',
    quitHint: 'Ctrl+C で記録を停止して安全に終了します',
    openingBrowser: '既定のブラウザーを開いています…',
    browserOpened: '既定のブラウザーで開くよう要求しました',
    browserFailed: 'ブラウザーを自動で開けませんでした。上記の URL を手動でブラウザーに貼り付けてください',
    alreadyRunning: 'LiveMemory はすでに実行中です。今回は起動しません。',
    alreadyRunningUrl: '実行中のコンソールを開きました:',
    portConflict: 'ポートが使用中だったため、別のローカルポートに切り替えました。',
    databaseError: 'データベースを開くか初期化できませんでした。',
    dataDirUnwritable: 'データフォルダーに書き込めません: {path}',
    dataDirHint: 'フォルダーの権限を確認するか、--data-dir で書き込み可能なフォルダーを指定してください。',
    unsupportedNode: 'Node.js {expected} 以降が必要です（現在: {actual}）。',
    sqliteUnavailable: 'この Node.js には組み込み SQLite（node:sqlite）がありません。Node.js 22.5 以降に更新してください。',
    lockFailed: '単一インスタンス用のロックファイルを作成できません: {path}',
    shuttingDown: '記録を停止して安全に終了しています…',
    exited: 'LiveMemory を安全に終了しました。',
    stoppedRecording: '記録を停止し、データをディスクに保存しました。',
    pressEnter: 'Enter キーでこのウィンドウを閉じます…',
    errorPrefix: 'エラー',
    fatalTitle: 'LiveMemory を起動できません',
    statusIdle: '待機中（記録していません）',
    statusStarting: '接続しています…',
    statusRecording: '記録中: {title}',
    statusRecordingStats: '受信 {messages} 件 · 視聴者 {viewers} 人',
    statusConnected: '接続済み',
    statusFailed: '配信への接続に失敗しました: {reason}',
    statusAuth: 'ログインの有効期限が切れました。再認証が必要です',
    statusStopped: '記録を停止しました',
    helpTitle: 'LiveMemory 起動オプション',
    helpBody: [
      '  --no-open            起動後にブラウザーを自動で開かない',
      '  --port <番号>        ローカルポートを指定（既定 47800、使用中なら自動で変更）',
      '  --data-dir <パス>    ユーザーデータフォルダーを指定',
      '  --lang <言語>        zh-CN | ja | en',
      '  --version            バージョンを表示',
      '  --help               このヘルプを表示'
    ].join('\n'),
    recoveredSessions: '正常終了していない配信が {count} 件あったため、「中断」として記録しました。',
    simulatedNote: '現在は記録フロー検証用のシミュレーション配信です（実際のプラットフォームのデータではありません）。',
    webHint: 'ヒント: ブラウザーを閉じても記録は続きます。終了はコマンドラインで Ctrl+C を押してください。'
  },
  en: {
    productLine: 'Local-first livestream memory system',
    starting: 'Starting LiveMemory…',
    checkingEnvironment: 'Checking the runtime environment…',
    environmentOk: 'Runtime environment looks good',
    dataDir: 'Data folder',
    consoleUrl: 'Console URL',
    logFile: 'Log folder',
    recording: 'Recording',
    quitting: 'To quit',
    quitHint: 'Press Ctrl+C to stop recording and exit safely',
    openingBrowser: 'Opening your default browser…',
    browserOpened: 'Asked the system to open your default browser',
    browserFailed: 'Could not open a browser automatically. Copy the console URL above into your browser',
    alreadyRunning: 'LiveMemory is already running. This window will not start a second copy.',
    alreadyRunningUrl: 'Opened the console that is already running:',
    portConflict: 'That port was busy, so LiveMemory moved to another local port.',
    databaseError: 'The database could not be opened or initialised.',
    dataDirUnwritable: 'The data folder is not writable: {path}',
    dataDirHint: 'Check permissions for that folder, or pass --data-dir with another writable folder.',
    unsupportedNode: 'Node.js {expected} or newer is required (found {actual}).',
    sqliteUnavailable: 'This Node.js build has no built-in SQLite (node:sqlite). Please upgrade to Node.js 22.5 or newer.',
    lockFailed: 'Could not create the single-instance lock file: {path}',
    shuttingDown: 'Stopping recording and shutting down safely…',
    exited: 'LiveMemory exited safely.',
    stoppedRecording: 'Recording stopped and data flushed to disk.',
    pressEnter: 'Press Enter to close this window…',
    errorPrefix: 'Error',
    fatalTitle: 'LiveMemory could not start',
    statusIdle: 'Idle (not recording)',
    statusStarting: 'Connecting…',
    statusRecording: 'Recording: {title}',
    statusRecordingStats: '{messages} messages · {viewers} viewers',
    statusConnected: 'Connected',
    statusFailed: 'Live connection failed: {reason}',
    statusAuth: 'Login expired — authorisation is required again',
    statusStopped: 'Recording stopped',
    helpTitle: 'LiveMemory launch options',
    helpBody: [
      '  --no-open            do not open a browser automatically',
      '  --port <number>      local port (default 47800, moves to the next free one)',
      '  --data-dir <path>    user data folder',
      '  --lang <locale>      zh-CN | ja | en',
      '  --version            print the version',
      '  --help               print this help'
    ].join('\n'),
    recoveredSessions: '{count} session(s) had not ended normally and were marked as interrupted.',
    simulatedNote: 'This is a simulated stream used to verify recording; it is not real platform data.',
    webHint: 'Tip: closing the browser does not stop recording. Press Ctrl+C here to finish.'
  }
};

export function cliMessages(locale) {
  return MESSAGES[locale] ?? MESSAGES.en;
}

export function formatMessage(template, params = {}) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => (
    Object.hasOwn(params, key) ? String(params[key]) : match
  ));
}

export function t(locale, key, params = {}) {
  const messages = cliMessages(locale);
  return formatMessage(messages[key] ?? MESSAGES.en[key] ?? key, params);
}

export const CLI_LOCALES = Object.freeze(Object.keys(MESSAGES));
