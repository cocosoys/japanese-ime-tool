# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## v1.0.0
### 新增
- 日语姓名抓取 → 一键导入 Windows 微软拼音「用户自定义短语」(EUDP)
- 多语言界面（简体中文 / English / 日本語 / 한국어 / 繁體中文）
- 批次命名（年-月-日_时分秒_毫秒）、独立「此后不再提醒」复选框、占位行底纹、`__all__` 智能分配
- 6 项应用内更新/回滚功能（自研 asar 热替换更新器，支持 GitHub + 镜像加速）
- NSIS 安装版 + 便携免安装版双发行
- 自研本地签名 / 上传发布工具（`scripts/local-release/`，不进仓库）

### 修复
- 打包后 ESM 启动崩溃（混淆脚本缺失 `type:"module"`）
- 安装到 Program Files 后配置写入失败（存储路径改为 `userData`）
