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
