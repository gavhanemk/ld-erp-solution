# LD ERP Solution
### AI-Powered ERP for Garment Manufacturing

<div align="center">

![Version](https://img.shields.io/badge/Version-1.0.0-teal?style=for-the-badge)
![Next.js](https://img.shields.io/badge/Next.js-15-black?style=for-the-badge&logo=next.js)
![Expo](https://img.shields.io/badge/React_Native-Expo-blue?style=for-the-badge&logo=expo)
![Node.js](https://img.shields.io/badge/Node.js-20-green?style=for-the-badge&logo=node.js)
![Prisma](https://img.shields.io/badge/Prisma-PostgreSQL-2D3748?style=for-the-badge&logo=prisma)
![Gemini](https://img.shields.io/badge/Gemini_AI-2.0_Flash-orange?style=for-the-badge&logo=google)

**Self-owned, AI-powered ERP for LD Cotton Mills**  
**Future SaaS product for garment industry**

</div>

---

## 🏗 Project Structure

```
LD ERP Solution/
├── apps/
│   ├── web/          → Next.js 15 Web App (erp.ldcottonmills.com)
│   ├── api/          → Node.js + Express Backend API
│   └── mobile/       → React Native + Expo (iOS/Android)
├── packages/
│   ├── database/     → Prisma ORM + PostgreSQL Schema
│   ├── shared/       → Shared types, utils, constants
│   └── ui/           → Shared UI components (future)
└── README.md
```

---

## ⚡ Quick Start

### Prerequisites
- Node.js 20+, pnpm 9+, PostgreSQL 16, Redis

```bash
# 1. Install
npm install -g pnpm
pnpm install

# 2. Setup env
cp apps/api/.env.example apps/api/.env      # Edit with your DB/API keys
cp apps/web/.env.example apps/web/.env.local

# 3. Database
pnpm db:generate
pnpm db:migrate
pnpm db:seed

# 4. Start (all apps)
pnpm dev

# Or individually:
pnpm dev:api   → http://localhost:5000
pnpm dev:web   → http://localhost:3000
```

**Default Login:** `admin@ldcottonmills.com` / `Admin@123`

---

## 📦 Modules

| Module | Web | Mobile | API | Status |
|--------|-----|--------|-----|--------|
| 🔐 Auth & RBAC | ✅ | ✅ | ✅ | Done |
| 📋 Masters | 🟡 | — | 🟡 | In Progress |
| 💰 Sales | 🟡 | 📱 | 🟡 | In Progress |
| 🛒 Purchase | ⬜ | — | ⬜ | Planned |
| 📦 Inventory | ⬜ | 📱 | ⬜ | Planned |
| 🏭 Production | ⬜ | 📱 | ⬜ | Planned |
| 🤝 Job Work | ⬜ | — | ⬜ | Planned |
| 🏷️ VHAGAR Brand | ⬜ | — | ⬜ | Planned |
| 📊 Accounts & GST | ⬜ | 📱 | ⬜ | Planned |
| 👤 HR & Payroll | ⬜ | — | ⬜ | Planned |
| 🔧 Maintenance | ⬜ | 📱 | ⬜ | Planned |
| 🤖 AI Assistant | ✅ | ✅ | ✅ | Done |

---

## 🤖 AI Features (Gemini 2.0)

- **In-app chat**: Ask anything in English/Hindi/Hinglish
- **Function calling**: AI directly queries ERP data
- **Daily MIS**: Auto-generated + sent via WhatsApp
- **Approvals**: Approve POs and SOs via chat
- **Forecasting**: Reorder predictions (coming soon)
- **Invoice scanning**: Extract data from supplier bills (coming soon)

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| Web | Next.js 15, TypeScript, Tailwind CSS |
| Mobile | React Native + Expo |
| API | Node.js + Express + TypeScript |
| Database | PostgreSQL 16 + Prisma ORM |
| Auth | JWT + Refresh Tokens + RBAC |
| AI | Google Gemini 2.0 Flash |
| Cache | Redis + BullMQ |
| Real-time | Socket.io |
| Storage | Cloudflare R2 |
| E-Invoice | GSTN IRN API |
| WhatsApp | WhatsApp Business Cloud API |

---

## 🔒 Default Credentials

| Role | Email | Password |
|------|-------|----------|
| Admin | admin@ldcottonmills.com | Admin@123 |
| MD | md@ldcottonmills.com | MD@12345 |

> ⚠️ **Change all passwords immediately after first login in production!**

---

## 📄 License

**PROPRIETARY** — © 2025 LD Cotton Mills. All rights reserved.  
For licensing inquiries, contact: info@ldcottonmills.com

---

*LD ERP Solution v1.0.0 — Built for LD Cotton Mills*
