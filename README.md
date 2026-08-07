# 纵跃 · Rooftop Run

一个使用 Three.js 制作的竖屏屋顶跳跃小游戏。玩家反向拖拽蓄力、松手起跳，在不断改变距离、横向位置与形状的楼顶之间持续向前。

## 在线试玩

- GitHub Pages：<https://bisoubisou0905.github.io/rooftop-leap-threejs/>
- 当前在线版：<https://rooftop-leap-game.joeylau0905.chatgpt.site/>

## 游戏特点

- 竖屏、单指反向拖拽操作
- 不显示轨迹线，依靠蓄力手感和空间判断
- 连续可见的程序化屋顶路线
- 三渲二塑料玩具风角色与搞笑空中动作
- 多套可切换的天空、云海与赛博城市背景
- 实体屋顶、建筑墙面和转角碰撞
- 轻量舒适的程序化音效
- 双人 18 段计时赛、自动匹配与右侧位置尺
- 轻量/重装角色质量差异与温和玩家碰撞
- 每人三条命、整局淘汰与按平台推进的水面追赶

## 免费双人联机

- 进入“双人”后点击“创建比赛并复制邀请”，把链接发给朋友即可；朋友点开后会直接加入，无需输入房间号。
- 每条邀请链接在内部使用独立比赛标识，因此多组玩家同时在线也不会进入彼此的比赛。
- 联机状态通过免费的 MQTT over Secure WebSocket 测试中继同步，因此不同 Wi-Fi、蜂窝网络或严格 NAT 下也不依赖 WebRTC 直连，不需要注册账号。
- 当前小规模原型使用 EMQX 公共测试 broker，GitHub Pages 只负责静态托管，没有持续服务器费用。公共 broker 不提供生产服务等级保证，请勿在房间号或游戏消息中放置个人信息；正式发布时应迁移到自有或托管 broker。

## 本地运行

```bash
npm install
npm run dev:github
```

## 构建

```bash
npm run build
npm run build:github
```

`build:github` 会生成 GitHub Pages 使用的静态文件。推送到 `main` 后，GitHub Actions 会自动部署试玩页面。
