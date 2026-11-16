# LiveMemory 十语言术语表（GLOSSARY）

状态：**P40 / I18N-M1 定稿（2026-11-16）**。本表是十份界面字典（`src/web/i18n/*.json`）
与启动器控制台（`src/launcher/cli-i18n.mjs`）翻译的**唯一术语依据**。任何新增或修改的文案
都必须先查本表；表里没有的词，先补表再翻译。

相关文档：`AGENTS.md` §6.16、§7；`docs/I18N.md` §3、§7；`docs/UI_DESIGN.md`。

---

## 1. 使用规则

1. **产品名 `LiveMemory` 永不翻译、永不音译、永不空格拆写**（不是「直播记忆」、不是
   `Live Memory`、不是 `ライブメモリー`）。它可以出现在任何语言的句子里，且不改变词形。
2. **键名、枚举值、错误码、平台字段名、货币代码、`platform:uid`、命令与路径、`--lang`
   参数值、HTML/Markdown 标记、`{placeholder}` 一律不翻译**，只翻译自然语言。
3. **一个概念在一种语言里只能有一种译法**。同义变体（如德语 `Sitzung` / `Session`）必须
   在首次落地时选定，之后不得混用。
4. **界面控件用名词或动作短语**（按钮、标签、胶囊），**说明文字用完整句子**。
   按钮不得写成「点击此处以保存」这类句子。
5. 语气：克制、客观、不营销、不堆感叹号、不用「亲」「哦」等口语助词；不使用 emoji。
6. 占位符 `{param}` 原样保留，位置可按目标语言语序调整；不得新增、改名或删除。
7. 平台名使用**各平台官方本地写法**，不音译：`Bilibili`、`YouTube`、`Twitch`、
   `抖音`（中国大陆）/ `Douyin`（其他语言）、`TikTok`。
8. 括号、引号、分隔符使用**目标语言习惯**：英语 `()`，中文 `（）`，日语 `（）`，
   法语 `« »` 或 `« »` + 不换行空格、德语 `„ "`、其他语言默认 `" "`。为降低风险，
   除中日常用全角括号外，其余语言统一使用直角引号 `"..."`。

---

## 2. 核心术语对照表

「zh-CN / ja / en」三列是**既有实现**，本轮不得改写；其余七列是 P40 新增语言的
**唯一指定译法**。

| # | 概念（源） | zh-CN（既有） | ja（既有） | en（源） | ko | es | pt-BR | zh-TW | fr | de | id |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | LiveMemory（产品名） | LiveMemory | LiveMemory | LiveMemory | LiveMemory | LiveMemory | LiveMemory | LiveMemory | LiveMemory | LiveMemory | LiveMemory |
| 2 | livestream / live broadcast | 直播 | 配信 | livestream | 라이브 방송 | directo | transmissão ao vivo | 直播 | direct | Livestream | siaran langsung |
| 3 | live room / room | 直播间 | 配信ルーム | live room | 라이브룸 | sala | sala | 直播間 | salon | Livestream-Raum | ruang siaran |
| 4 | broadcaster / streamer | 主播 | 配信者 | broadcaster | 방송자 | creador | criador | 直播主 | créateur | Streamer | penyiar |
| 5 | viewer | 观众 | 視聴者 | viewer | 시청자 | espectador | espectador | 觀眾 | spectateur | Zuschauer | penonton |
| 6 | nickname | 昵称 | ニックネーム | nickname | 닉네임 | apodo | apelido | 暱稱 | pseudonyme | Anzeigename | nama panggilan |
| 7 | viewer ID / stable ID | 观众 ID / 稳定 ID | 視聴者 ID / 安定 ID | stable ID | 시청자 ID / 고정 ID | ID estable | ID estável | 觀眾 ID / 穩定 ID | identifiant stable | stabile ID | ID stabil |
| 8 | chat message（弹幕） | 弹幕 | コメント | chat message | 채팅 메시지 | mensaje de chat | mensagem de chat | 聊天訊息 | message de chat | Chat-Nachricht | pesan chat |
| 9 | session（单场记录） | 场次 | セッション | session | 세션 | sesión | sessão | 場次 | session | Sitzung | sesi |
| 10 | single-session report | 单场报告 | 単一セッションのレポート | session report | 세션 리포트 | informe de sesión | relatório da sessão | 單場報告 | rapport de session | Sitzungsbericht | laporan sesi |
| 11 | long-term memory / profile | 长期画像 | 長期プロフィール | long-term memory | 장기 프로필 | perfil a largo plazo | perfil de longo prazo | 長期畫像 | profil à long terme | Langzeitprofil | profil jangka panjang |
| 12 | AI analysis | AI 分析 | AI 分析 | AI analysis | AI 분석 | análisis con IA | análise com IA | AI 分析 | analyse IA | KI-Analyse | analisis AI |
| 13 | AI analysis center | AI 分析中心 | AI 分析センター | AI analysis center | AI 분석 센터 | centro de análisis con IA | central de análise com IA | AI 分析中心 | centre d'analyse IA | KI-Analysezentrum | pusat analisis AI |
| 14 | analysis batch | 分析批次 | 分析バッチ | analysis batch | 분석 배치 | lote de análisis | lote de análise | 分析批次 | lot d'analyse | Analyse-Stapel | batch analisis |
| 15 | analysis task / job | 分析任务 | 分析タスク | analysis task | 분석 작업 | tarea de análisis | tarefa de análise | 分析任務 | tâche d'analyse | Analyseauftrag | tugas analisis |
| 16 | analysis progress | 分析进度 | 分析の進捗 | analysis progress | 분석 진행률 | progreso del análisis | progresso da análise | 分析進度 | progression de l'analyse | Analysefortschritt | kemajuan analisis |
| 17 | reconnect / reconnecting | 重连 / 正在重连 | 再接続 | reconnect | 재연결 | reconectar | reconectar | 重新連線 | reconnexion | Neuverbindung | menyambung ulang |
| 18 | automatic recovery | 自动恢复 | 自動復旧 | automatic recovery | 자동 복구 | recuperación automática | recuperação automática | 自動恢復 | rétablissement automatique | automatische Wiederherstellung | pemulihan otomatis |
| 19 | resume（继续分析） | 继续分析 | 分析を再開 | resume | 계속 분석 | reanudar | retomar | 繼續分析 | reprendre | fortsetzen | lanjutkan |
| 20 | import / export | 导入 / 导出 | インポート / エクスポート | import / export | 가져오기 / 내보내기 | importar / exportar | importar / exportar | 匯入 / 匯出 | importer / exporter | importieren / exportieren | impor / ekspor |
| 21 | backup / restore | 备份 / 恢复 | バックアップ / 復元 | backup / restore | 백업 / 복원 | copia de seguridad / restaurar | backup / restaurar | 備份 / 還原 | sauvegarde / restauration | Sicherung / Wiederherstellung | cadangan / pulihkan |
| 22 | platform connection status | 平台连接状态 | プラットフォーム接続状態 | platform connection status | 플랫폼 연결 상태 | estado de conexión de la plataforma | status da conexão da plataforma | 平台連線狀態 | état de connexion | Plattformverbindung | status koneksi platform |
| 23 | error / warning | 错误 / 警告 | エラー / 警告 | error / warning | 오류 / 경고 | error / advertencia | erro / aviso | 錯誤 / 警告 | erreur / avertissement | Fehler / Warnung | kesalahan / peringatan |
| 24 | support / paid events | 打赏 | 投げ銭 | support | 후원 | apoyo | apoio | 打賞 | soutien | Unterstützung | dukungan |
| 25 | evidence | 证据 | 根拠 | evidence | 근거 | evidencia | evidência | 證據 | preuve | Beleg | bukti |
| 26 | fact | 事实 | 事実 | fact | 사실 | hecho | fato | 事實 | fait | Fakt | fakta |
| 27 | stated / inferred / uncertain | 明确陈述 / 推断 / 不确定 | 明示 / 推測 / 不確実 | stated / inferred / uncertain | 명시 / 추론 / 불확실 | declarado / inferido / incierto | declarado / inferido / incerto | 明確陳述 / 推論 / 不確定 | déclaré / déduit / incertain | belegt / abgeleitet / unsicher | dinyatakan / disimpulkan / tidak pasti |
| 28 | confidence | 置信度 | 信頼度 | confidence | 신뢰도 | confianza | confiança | 信心度 | confiance | Konfidenz | keyakinan |
| 29 | AI provider (Provider) | AI 服务商 | AI プロバイダー | AI provider | AI 제공자 | proveedor de IA | provedor de IA | AI 服務商 | fournisseur d'IA | KI-Anbieter | penyedia AI |
| 30 | API Key | API Key | API キー | API key | API 키 | clave de API | chave de API | API 金鑰 | clé d'API | API-Schlüssel | kunci API |
| 31 | prompt | 提示词 | プロンプト | prompt | 프롬프트 | instrucciones | instruções | 提示詞 | consignes | Anweisung | perintah |
| 32 | batch（文件批次） | 批次 | バッチ | batch | 배치 | lote | lote | 批次 | lot | Stapel | batch |
| 33 | schema | 结构 | スキーマ | schema | 스키마 | esquema | esquema | 結構定義 | schéma | Schema | skema |
| 34 | retention | 保留 | 保持 | retention | 보관 | retención | retenção | 保留 | conservation | Aufbewahrung | penyimpanan |
| 35 | data folder | 数据目录 | データフォルダー | data folder | 데이터 폴더 | carpeta de datos | pasta de dados | 資料夾 | dossier de données | Datenordner | folder data |
| 36 | console | 控制台 | コンソール | console | 콘솔 | consola | console | 主控台 | console | Konsole | konsol |
| 37 | analyse again | 重新分析 | 再分析 | analyse again | 다시 분석 | volver a analizar | analisar novamente | 重新分析 | relancer l'analyse | erneut analysieren | analisis ulang |
| 38 | identified viewers | 可识别观众 | 識別済み視聴者 | identified viewers | 식별된 시청자 | espectadores identificados | espectadores identificados | 可識別觀眾 | spectateurs identifiés | erkannte Zuschauer | penonton teridentifikasi |
| 39 | unassigned | 未归属 | 未割り当て | unassigned | 미지정 | sin asignar | não atribuído | 未歸屬 | non attribué | nicht zugeordnet | belum ditetapkan |
| 40 | confirmed / needs confirmation | 已确认 / 待确认 | 確認済み / 要確認 | confirmed / needs confirmation | 확인됨 / 확인 필요 | confirmado / por confirmar | confirmado / a confirmar | 已確認 / 待確認 | confirmé / à confirmer | bestätigt / zu bestätigen | terkonfirmasi / perlu konfirmasi |
| 41 | outdated / superseded / conflicted | 可能过期 / 已被取代 / 存在冲突 | 古い可能性 / 置き換え済み / 矛盾 | outdated / superseded / conflicted | 오래됨 / 대체됨 / 충돌 | desactualizado / reemplazado / en conflicto | desatualizado / substituído / em conflito | 可能過期 / 已被取代 / 存在衝突 | obsolète / remplacé / en conflit | veraltet / ersetzt / widersprüchlich | usang / digantikan / bertentangan |
| 42 | local-first | 本地优先 | ローカル優先 | local-first | 로컬 우선 | local primero | local em primeiro lugar | 本機優先 | local d'abord | lokal zuerst | mengutamakan lokal |
| 43 | live chart | 实时图表 | リアルタイムグラフ | live chart | 실시간 차트 | gráfico en vivo | gráfico ao vivo | 即時圖表 | graphique en direct | Live-Diagramm | grafik langsung |
| 44 | timeline | 时间线 | タイムライン | timeline | 타임라인 | línea de tiempo | linha do tempo | 時間軸 | chronologie | Zeitachse | linimasa |
| 45 | highlight | 精彩片段 | ハイライト | highlight | 하이라이트 | momento destacado | destaque | 精華片段 | moment fort | Höhepunkt | sorotan |
| 46 | local only / stays on this computer | 仅本地 / 数据只留在这台电脑上 | ローカルのみ / この PC 内に留まります | local only | 로컬 전용 | solo local | somente local | 僅本機 | local uniquement | nur lokal | hanya lokal |
| 47 | simulated（历史 mock 数据） | 模拟 | シミュレーション | simulated | 시뮬레이션 | simulado | simulado | 模擬 | simulé | simuliert | simulasi |
| 48 | live room ID / room ID | 直播间 ID / 房间号 | 配信ルーム ID | room ID | 라이브룸 ID | ID de sala | ID da sala | 直播間 ID | ID du salon | Raum-ID | ID ruang |
| 49 | archive / unarchive | 归档 / 取消归档 | アーカイブ / 解除 | archive / unarchive | 보관 / 보관 해제 | archivar / desarchivar | arquivar / desarquivar | 封存 / 取消封存 | archiver / désarchiver | archivieren / wiederherstellen | arsipkan / batalkan arsip |
| 50 | backfill / gap | 可能遗漏 / 缺口 | 欠落の可能性 | possible gap | 누락 가능 | posible hueco | possível lacuna | 可能遺漏 | lacune possible | mögliche Lücke | kemungkinan celah |

### 2b. 界面动作词与状态词（高频，必须全篇一致）

| # | en | zh-CN（既有） | ja（既有） | ko | es | pt-BR | zh-TW | fr | de | id |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | Record / Recording | 记录 / 正在记录 | 記録 / 記録中 | 기록 / 기록 중 | grabar / grabando | gravar / gravando | 記錄 / 正在記錄 | enregistrer / enregistrement | aufzeichnen / Aufzeichnung | rekam / merekam |
| A2 | Start recording | 开始记录 | 記録を開始 | 기록 시작 | iniciar grabación | iniciar gravação | 開始記錄 | démarrer l'enregistrement | Aufzeichnung starten | mulai merekam |
| A3 | Stop | 停止 | 停止 | 중지 | detener | parar | 停止 | arrêter | beenden | hentikan |
| A4 | Connect / Connected | 连接 / 已连接 | 接続 / 接続済み | 연결 / 연결됨 | conectar / conectado | conectar / conectado | 連線 / 已連線 | connecter / connecté | verbinden / verbunden | sambungkan / tersambung |
| A5 | Check | 检查 | 確認 | 확인 | comprobar | verificar | 檢查 | vérifier | prüfen | periksa |
| A6 | Retry | 重试 | 再試行 | 다시 시도 | reintentar | tentar novamente | 重試 | réessayer | erneut versuchen | coba lagi |
| A7 | Save | 保存 | 保存 | 저장 | guardar | salvar | 儲存 | enregistrer | speichern | simpan |
| A8 | Cancel | 取消 | キャンセル | 취소 | cancelar | cancelar | 取消 | annuler | abbrechen | batal |
| A9 | Delete | 删除 | 削除 | 삭제 | eliminar | excluir | 刪除 | supprimer | löschen | hapus |
| A10 | Confirm | 确认 | 確認する | 확인 | confirmar | confirmar | 確認 | confirmer | bestätigen | konfirmasi |
| A11 | Search | 搜索 | 検索 | 검색 | buscar | pesquisar | 搜尋 | rechercher | suchen | cari |
| A12 | Filter | 筛选 | 絞り込み | 필터 | filtrar | filtrar | 篩選 | filtrer | filtern | filter |
| A13 | Download | 下载 | ダウンロード | 다운로드 | descargar | baixar | 下載 | télécharger | herunterladen | unduh |
| A14 | Copy | 复制 | コピー | 복사 | copiar | copiar | 複製 | copier | kopieren | salin |
| A15 | Report | 报告 | レポート | 리포트 | informe | relatório | 報告 | rapport | Bericht | laporan |
| A16 | Progress | 进度 | 進捗 | 진행률 | progreso | progresso | 進度 | progression | Fortschritt | kemajuan |
| A17 | Done / Failed / Pending | 完成 / 失败 / 待处理 | 完了 / 失敗 / 待機 | 완료 / 실패 / 대기 | hecho / fallido / pendiente | concluído / falhou / pendente | 完成 / 失敗 / 待處理 | terminé / échec / en attente | fertig / fehlgeschlagen / ausstehend | selesai / gagal / tertunda |
| A18 | Settings | 设置 | 設定 | 설정 | ajustes | configurações | 設定 | paramètres | Einstellungen | pengaturan |

---

## 3. 逐语言风格卡

翻译时按本卡执行；与其他规则冲突时，以 §1 使用规则为准。

### 3.1 zh-CN（简体中文，既有）
- 已实现，**本轮不改任何既有译文**。新增/调整文案才参考本表。
- 称呼省略主语；用「你」不用「您」；术语用「直播间」「场次」「观众」「弹幕」「长期画像」。

### 3.2 ja（日本語，既有）
- 已实现，**本轮不改任何既有译文**。
- です・ます体；按钮用名词或「〜する」短语；外来语用片假名（セッション、バッチ、プロンプト）。

### 3.3 en（English，源文件）
- 源语言。**本轮不改任何既有英文文案**（源句即基准）。
- 句子用 sentence case；按钮用动词或名词短语；不用「please」堆砌。

### 3.4 ko（한국어）
- 句式：**합니다体**（正式书面），说明文字用完整句；按钮用名词或「~하기」（예: 저장, 취소, 다시 시도, 내보내기）。
- 空格分写依韩文正字法；数字与单位之间不空格；`LiveMemory` 前后各留一个半角空格。
- 术语：세션, 배치, 시청자, 라이브룸, 방송자, 채팅 메시지, 장기 프로필, AI 분석.
- 避免直译英语语序（"~에 대해" 少用），用韩语惯用的「~합니다」「~합니다.」。
- 不混用「시청자」与「뷰어」；不混用「세션」与「방송 기록」。

### 3.5 es（Español，通用西班牙语）
- 句子用**无人称/被动反身**（"No se pudo abrir…"）或第三人称；按钮用**不定式**
  （Guardar, Cancelar, Reintentar）。不写 "usted" / "tú" 代词（动词变位体现即可）。
- 术语：directo, sala, espectador, creador, sesión, lote, perfil a largo plazo,
  análisis con IA, evidencia, confianza.
- 不区分 es-419 / es-MX；使用中性词，避免地域俚语（ordenador→PC）。
- 数字小数点用逗号（1,5 s）需与运行时 `Intl` 一致；**文案里的静态数字保持阿拉伯数字**。

### 3.6 pt-BR（Português do Brasil）
- 巴西葡萄牙语，**不是** pt-PT。句子用第三人称/无人称（"Não foi possível abrir…"），
  按钮用不定式（Salvar, Cancelar, Tentar novamente）。
- 术语：transmissão ao vivo, sala, espectador, criador, sessão, lote,
  perfil de longo prazo, análise com IA, evidência, confiança.
- 用 "arquivo"（不是 ficheiro）、"tela"（不是 ecrã）、"usuário"（不是 utilizador）。

### 3.7 zh-TW（繁體中文，台灣用語）
- 台灣軟體用語：資料夾、設定、網路、影片、連結、預設、支援、品質、登入、帳號、
  伺服器、資料庫、程式、介面、匯入、匯出、備份、還原、封存。
- **禁止**中國大陸用詞：文件夹、设置、网络、视频、链接、默认、支持、质量、登录、
  账号、服务器、数据库、程序、界面、导入、导出。
- 全形標點（，。：；！？（）），引號用「」；數字與英文之間加半角空格。
- 術語：直播間、觀眾、聊天訊息、場次、長期畫像、AI 分析、分析批次、重新連線。

### 3.8 fr（Français）
- 句子用 **vous**（vouvoiement），动词变位体现，可省略代词；按钮用**不定式**
  （Enregistrer, Annuler, Réessayer）。
- 术语：direct, salon, spectateur, créateur, session, lot, profil à long terme,
  analyse IA, preuve, confiance.
- 法语排版：冒号、分号、问号、感叹号前加**不换行空格**（`\u00A0`）；引号用 «  »。
  为保证 JSON 稳定，本轮**统一使用半角空格 + 直角引号 `"..."`**，仅在既有中文/日文
  文案里保留全角标点；法语不使用 `« »`。
- 避免英语直译（"faire sens" 少用）；用 "Vous pouvez…" 或无人称 "Il est possible de…"。

### 3.9 de（Deutsch）
- 句子用 **Sie**（formell）；按钮用**不定式**（Speichern, Abbrechen, Erneut versuchen）。
- 术语：Livestream, Livestream-Raum, Zuschauer, Streamer, Sitzung, Stapel,
  Langzeitprofil, KI-Analyse, Beleg, Konfidenz.
- 德语复合词长，**允许**在界面里用较短同义词换取可读性（例如用 "Sitzung" 而非
  "Aufzeichnungssitzung"），但同一概念全篇一致。
- 名词首字母大写；不使用 ß 以外的特殊字符（ä ö ü 正常使用）。

### 3.10 id（Bahasa Indonesia）
- 标准印尼语（baku），句子用主动语态、简短；按钮用动词原形（Simpan, Batal, Coba lagi）。
- 术语：siaran langsung, ruang siaran, penonton, penyiar, sesi, batch,
  profil jangka panjang, analisis AI, bukti, keyakinan.
- 不用口语（nggak, udah）、不用马来语特有词（bila→jika, faham→paham 注意）。
- 语态：避免 "Anda" 过多，用无人称被动 "tidak dapat dibuka"。

---

## 4. 不翻译清单（所有语言通用）

| 类别 | 例子 | 处理 |
| --- | --- | --- |
| 产品名 | `LiveMemory` | 原样 |
| 平台名 | `Bilibili`、`YouTube`、`Twitch`、`TikTok`、`Douyin`/`抖音` | 原样；`抖音` 在非中文界面用 `Douyin` |
| 技术标识 | `JSON`、`ZIP`、`SQLite`、`API`、`SSE`、`HTTP`、`UTF-8`、`WAL` | 原样（大小写照源文） |
| 错误码 | `SESSION_DUPLICATE_ROOM`、`AI_JOB_INVALID` | 原样 |
| 语言参数 | `--lang zh-CN`、`--port`、`--data-dir` | 原样 |
| 路径/文件夹 | `%LOCALAPPDATA%\LiveMemory`、`config/settings.json` | 原样 |
| 文件扩展名 | `.livememory`、`.zip`、`.json` | 原样 |
| 货币代码 | `CNY`、`USD`、`JPY` | 原样 |
| 身份写法 | `bilibili:12345`、`platform:uid` | 原样（`platform:` 前缀不译） |
| 占位符 | `{name}`、`{n}`、`{locale}` | 原样 |
| 品牌/服务商 | `OpenAI`、`Anthropic`、`DeepSeek`、`MiniMax`、`OpenRouter` | 原样 |

---

## 5. 质量门禁（与本表配套的自动化检查）

| 门禁 | 判定 | 位置 |
| --- | --- | --- |
| 键集一致 | 十份字典相对 `en.json` 缺失 0、多余 0 | `tests/unit/i18n.test.mjs` |
| 占位符一致 | 每键 `{param}` 集合完全相同 | `tests/unit/i18n.test.mjs` |
| 非空 | 全部为非空 string | `tests/unit/i18n.test.mjs` |
| 残留英文 | 非英语字典不得整键等于英文源值（白名单除外） | `tests/unit/i18n.test.mjs` |
| 目标文字存在 | 除 `LiveMemory` 等白名单外，每份字典必须含该语言文字 | `tests/unit/i18n.test.mjs` |
| 原生语言名 | `settings.language.*` 与注册表一致 | `tests/unit/locale-registry.test.mjs` |
| 启动器键集 | `cli-i18n` 十语言键集与占位符一致 | `tests/unit/i18n.test.mjs` |

白名单（允许与英文源完全相同的键）：纯品牌/技术词条，例如
`common.platform.bilibili` / `common.platform.youtube` / `common.platform.twitch` /
`common.platform.tiktok` / `settings.language.en`，以及只含 `LiveMemory`、`API`、
`JSON`、`.livememory` 等标识的短句。白名单必须逐条列入测试，不得整类跳过。

---

## 6. 维护规则

1. 新增术语：先加到 §2，再改译文；不得只在某个 JSON 里改。
2. 修改既有 `zh-CN` / `ja` / `en` 译文不属于 P40 范围；如确需修改，单独记录并说明理由。
3. 术语冲突时以本表为准；本表未覆盖时以 `en.json` 的语义为准，并在同轮补表。
4. 本文件与 `docs/I18N.md` §7 一起构成「新增语言必须遵循的翻译规范」。
