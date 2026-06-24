/************************************************************************
 * Dashboard Queue Processor
 *
 * Polls the `dashboard_queue` table on a timer and applies pending
 * actions to LIVE characters through the server's own validated APIs.
 * This is the safe write-channel for the dashboard admin tool: Node
 * INSERTs rows, this module executes them in-process against the live
 * in-memory player, so saves can't corrupt and items can't dupe.
 *
 * Patterns CONFIRMED against this repo:
 *   - modules/retail_plus/cpp/retail_plus_db.cpp  (CPPModule, db::preparedStmt,
 *     FOR_DB_SINGLE_RESULT, REGISTER_CPP_MODULE, OFFSET-loop for multi-row)
 *   - modules/tools/packetcap/packetcap.cpp       (include list, OnTimeServerTick)
 *   - src/map/utils/moduleutils.h                 (virtual OnTimeServerTick)
 *   - src/map/utils/zoneutils.h                   (GetChar(charId) -> CCharEntity*)
 *   - src/map/utils/charutils.h                   (AddItem(PChar, loc, itemID, qty))
 *   - src/map/utils/charutils.h                   (UpdateItem(PChar, loc, slot, qty))
 *   - src/map/item_container.h                    (LOC_INVENTORY = 0)
 *   - src/map/entities/char_entity.h              (renamed from charentity.h)
 *   - src/map/entities/mob_entity.h               (renamed from mobentity.h)
 *   - src/map/entities/npc_entity.h               (renamed from npcentity.h)
 *
 * v2 SCOPE: additem / delitem / setgil / addgil.
 *   Gil lives at LOC_INVENTORY slot 0, itemId 65535.
 *   UpdateItem(PChar, LOC_INVENTORY, 0, delta) is confirmed safe — it is
 *   the exact path LSB itself uses when distributing kill-drop gil.
 *
 * NOT independently verified - flagging for fast diagnosis if build fails:
 *   1. db::preparedStmt return type supports ->next() iteration directly.
 *      retail_plus_db.cpp only ever read single rows via FOR_DB_SINGLE_RESULT,
 *      so for the multi-row pending scan we use the SAME safe idiom: a
 *      bounded OFFSET loop of single-row queries, not an assumed iterator.
 *   2. timer::time_point / os time access in a module - we use std::time
 *      via <ctime> for the throttle, which has no codebase dependency.
 *   3. UpdateItem with a negative quantity removes items (confirmed by
 *      setGil's use: UpdateItem(PChar, LOC_INVENTORY, 0, -gil)). delitem
 *      relies on this; if the signature differs, only delitem is affected.
 ************************************************************************/

#include "common/database.h"
#include "map/entities/char_entity.h"
#include "map/entities/mob_entity.h"
#include "map/entities/npc_entity.h"
#include "map/items/item.h"
#include "map/lua/luautils.h"
#include "map/packets/s2c/0x062_clistatus2.h"
#include "map/utils/charutils.h"
#include "map/utils/zoneutils.h"
#include "map/utils/moduleutils.h"
#include "map/item_container.h"

#include <algorithm>
#include <ctime>
#include <fstream>
#include <string>
#include <cstdlib>

namespace
{
    constexpr int      DQ_POLL_INTERVAL = 3;   // seconds between queue polls
    constexpr uint32   DQ_MAX_PER_POLL  = 20;  // rows handled per poll
    constexpr int      DQ_POS_INTERVAL  = 1;   // seconds between position snapshots
    constexpr auto     DQ_POS_FILE      = "/server/log/dashboard_positions.json";
    constexpr auto     DQ_POS_TMP       = "/server/log/dashboard_positions.json.tmp";
    std::time_t        g_lastPoll       = 0;
    std::time_t        g_lastPos        = 0;

    // Strip non-printable and non-ASCII bytes so NPC/mob names are always valid JSON UTF-8.
    auto jsonName = [](const std::string& s) -> std::string {
        std::string out;
        out.reserve(s.size());
        for (unsigned char c : s) {
            if      (c == '"')  { out += "\\\""; }
            else if (c == '\\') { out += "\\\\"; }
            else if (c >= 0x20 && c < 0x7F) { out += static_cast<char>(c); }
        }
        return out;
    };

    void writePosFeed()
    {
        std::string players, npcs, mobs;
        players.reserve(256);
        npcs.reserve(512);
        mobs.reserve(1024);
        bool fp = true, fn = true, fm = true;

        zoneutils::ForEachZone([&](CZone* zone)
        {
            zone->ForEachChar([&](CCharEntity* PChar)
            {
                if (!fp) players += ',';
                fp = false;
                players += fmt::format(
                    R"({{"i":{},"n":"{}","x":{:.2f},"y":{:.2f},"z":{:.2f},"z_id":{},"j":{},"l":{}}})",
                    PChar->id, jsonName(PChar->name),
                    PChar->loc.p.x, PChar->loc.p.y, PChar->loc.p.z,
                    PChar->getZone(),
                    static_cast<int>(PChar->GetMJob()), PChar->GetMLevel());
            });
            zone->ForEachNpc([&](CNpcEntity* PNpc)
            {
                if (!fn) npcs += ',';
                fn = false;
                npcs += fmt::format(
                    R"({{"i":{},"n":"{}","x":{:.2f},"y":{:.2f},"z":{:.2f},"z_id":{}}})",
                    PNpc->id, jsonName(PNpc->name),
                    PNpc->loc.p.x, PNpc->loc.p.y, PNpc->loc.p.z,
                    PNpc->getZone());
            });
            zone->ForEachMob([&](CMobEntity* PMob)
            {
                if (!fm) mobs += ',';
                fm = false;
                mobs += fmt::format(
                    R"({{"i":{},"n":"{}","x":{:.2f},"y":{:.2f},"z":{:.2f},"z_id":{}}})",
                    PMob->id, jsonName(PMob->name),
                    PMob->loc.p.x, PMob->loc.p.y, PMob->loc.p.z,
                    PMob->getZone());
            });
        });

        std::string json = R"({"players":[)" + players + R"(],"npcs":[)" + npcs + R"(],"mobs":[)" + mobs + "]}";

        // Atomic write: tmp then rename to avoid partial reads by Node.js.
        {
            std::ofstream tmp(DQ_POS_TMP, std::ios::trunc);
            if (tmp) { tmp << json; }
        }
        std::rename(DQ_POS_TMP, DQ_POS_FILE);
    }

    // Pull an integer value out of a tiny JSON-ish params string.
    // e.g. paramInt("{\"item\":4102,\"qty\":12}", "item") -> 4102
    auto paramInt(const std::string& params, const std::string& key, int32 fallback) -> int32
    {
        const auto needle = "\"" + key + "\"";
        const auto kpos   = params.find(needle);
        if (kpos == std::string::npos)
        {
            return fallback;
        }
        const auto colon = params.find(':', kpos + needle.size());
        if (colon == std::string::npos)
        {
            return fallback;
        }
        // Skip spaces, parse the (possibly negative) integer that follows.
        std::size_t i = colon + 1;
        while (i < params.size() && (params[i] == ' ' || params[i] == '\t'))
        {
            ++i;
        }
        const char* start = params.c_str() + i;
        char*       end   = nullptr;
        const long  val   = std::strtol(start, &end, 10);
        if (end == start)
        {
            return fallback;
        }
        return static_cast<int32>(val);
    }

    // Mark a queue row resolved.
    void finishRow(uint32 id, const char* status, const std::string& result)
    {
        db::preparedStmt(
            "UPDATE dashboard_queue SET status = ?, result = ?, processed_at = NOW() WHERE id = ?",
            status, result, id);
    }
}

class DashboardQueueModule : public CPPModule
{
public:
    void OnInit() override
    {
        ShowInfo("[dashboard_queue] processor module loaded");
    }

    void OnTimeServerTick() override
    {
        const std::time_t now = std::time(nullptr);

        // Position feed: write all online player positions every 1 s.
        if (now - g_lastPos >= DQ_POS_INTERVAL)
        {
            g_lastPos = now;
            writePosFeed();
        }

        if (now - g_lastPoll < DQ_POLL_INTERVAL)
        {
            return;
        }
        g_lastPoll = now;

        // Bounded OFFSET loop of single-row reads (the one confirmed multi-row
        // idiom in this codebase). We always read OFFSET 0 because each handled
        // row is flipped out of 'pending', so the next pending row becomes the
        // new row 0 - this naturally drains the queue without offset drift.
        for (uint32 handled = 0; handled < DQ_MAX_PER_POLL; ++handled)
        {
            const auto rset = db::preparedStmt(
                "SELECT id, charid, action, params FROM dashboard_queue "
                "WHERE status = 'pending' ORDER BY id ASC LIMIT 1");

            bool found = false;
            FOR_DB_SINGLE_RESULT(rset)
            {
                found = true;

                const uint32      id     = rset->get<uint32>("id");
                const uint32      charid = rset->get<uint32>("charid");
                const std::string action = rset->get<std::string>("action");
                const std::string params = rset->get<std::string>("params");

                processOne(id, charid, action, params);
            }

            if (!found)
            {
                break; // queue drained
            }
        }
    }

private:
    static void processOne(uint32 id, uint32 charid, const std::string& action, const std::string& params)
    {
        // Server-level action — no character target needed.
        if (action == "luaexec")
        {
            // params is raw Lua source (not JSON-wrapped).
            auto result = ::lua.safe_script(params, sol::script_pass_on_error);
            if (!result.valid())
            {
                const sol::error err = result;
                finishRow(id, "error", err.what());
            }
            else
            {
                auto retStr = result.get<sol::optional<std::string>>();
                finishRow(id, "done", retStr.value_or("ok"));
            }
            return;
        }

        CCharEntity* PChar = zoneutils::GetChar(charid);
        if (PChar == nullptr)
        {
            // Not online on this process - defer rather than risk a DB write
            // to a character whose authoritative state lives elsewhere.
            finishRow(id, "deferred", "target not online on this process");
            return;
        }

        if (action == "additem")
        {
            const int32 item = paramInt(params, "item", -1);
            const int32 qty  = paramInt(params, "qty", 1);
            if (item < 0 || item > 65534)
            {
                finishRow(id, "error", "missing or invalid item id");
                return;
            }
            if (qty < 1 || qty > 99)
            {
                finishRow(id, "error", "qty out of range (1-99)");
                return;
            }
            const uint8 slot = charutils::AddItem(PChar, LOC_INVENTORY,
                                                  static_cast<uint16>(item),
                                                  static_cast<uint32>(qty));
            if (slot == ERROR_SLOTID)
            {
                finishRow(id, "error", "AddItem failed (inventory full or invalid item)");
            }
            else
            {
                finishRow(id, "done", "gave item " + std::to_string(item) + " x" + std::to_string(qty));
            }
        }
        else if (action == "delitem")
        {
            const int32 item = paramInt(params, "item", -1);
            const int32 qty  = paramInt(params, "qty", 1);
            if (item < 0 || item > 65534)
            {
                finishRow(id, "error", "missing or invalid item id");
                return;
            }
            // hasItem returns the slot the item is in, or ERROR_SLOTID if absent.
            const uint8 slot = PChar->getStorage(LOC_INVENTORY)->SearchItem(static_cast<uint16>(item));
            if (slot == ERROR_SLOTID)
            {
                finishRow(id, "error", "player does not have that item in inventory");
                return;
            }
            charutils::UpdateItem(PChar, LOC_INVENTORY, slot, -qty);
            finishRow(id, "done", "removed item " + std::to_string(item) + " x" + std::to_string(qty));
        }
        else if (action == "setgil" || action == "addgil")
        {
            constexpr uint16 GIL_ID  = 65535;
            constexpr int32  GIL_MAX = 2'000'000'000;

            CItem* PGil = PChar->getStorage(LOC_INVENTORY)->GetItem(0);
            const int32 current = (PGil && PGil->getID() == GIL_ID)
                                      ? static_cast<int32>(PGil->getQuantity())
                                      : 0;

            int32 target = 0;
            if (action == "setgil")
            {
                target = paramInt(params, "gil", -1);
                if (target < 0 || target > GIL_MAX)
                {
                    finishRow(id, "error", "gil value out of range (0–2,000,000,000)");
                    return;
                }
            }
            else // addgil — signed delta, may be negative to subtract
            {
                const int32 delta = paramInt(params, "gil", 0);
                target = std::clamp(current + delta, 0, GIL_MAX);
            }

            const int32 diff = target - current;
            if (diff != 0)
            {
                charutils::UpdateItem(PChar, LOC_INVENTORY, 0, diff);
            }
            finishRow(id, "done", "gil " + std::to_string(current) + " -> " + std::to_string(target));
        }
        else if (action == "setskill")
        {
            const int32 skillId = paramInt(params, "skill", -1);
            const int32 level   = paramInt(params, "level", -1);

            // Valid named skill IDs: 1-12 (combat weapons), 22-45 (ranged/magic/misc),
            // 48-59 (crafts: fishing through dig). Gaps 13-21 and 46-47 are unused.
            const bool validId = (skillId >= 1  && skillId <= 12)
                              || (skillId >= 22 && skillId <= 45)
                              || (skillId >= 48 && skillId <= 59);
            if (!validId)
            {
                finishRow(id, "error", "invalid skill id (valid: 1-12, 22-45, 48-59)");
                return;
            }
            if (level < 0 || level > 500)
            {
                finishRow(id, "error", "level out of range (0-500)");
                return;
            }

            const auto prev = PChar->RealSkills.skill[skillId] / 10;
            PChar->RealSkills.skill[skillId] = static_cast<uint16>(level * 10);
            PChar->RealSkills.rank[skillId]  = 0;
            charutils::BuildingCharSkillsTable(PChar);
            PChar->pushPacket<GP_SERV_COMMAND_CLISTATUS2>(PChar);
            charutils::SaveCharSkills(PChar, static_cast<uint8>(skillId));
            finishRow(id, "done",
                "skill " + std::to_string(skillId) + ": " +
                std::to_string(prev) + " -> " + std::to_string(level));
        }
        else
        {
            finishRow(id, "error", "unknown action: " + action);
        }
    }
};

REGISTER_CPP_MODULE(DashboardQueueModule);
