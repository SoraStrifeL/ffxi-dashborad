import { describe, it, expect } from 'vitest';
import { parseIdsTextTable, extractTextRefs } from '../../src/npc-dialog';

describe('parseIdsTextTable', () => {
  it('parses const = id, -- comment entries inside the text table', () => {
    const source = `
zones[xi.zone.SOUTHERN_SAN_DORIA_S] =
{
    text =
    {
        ITEM_DELIVERY_DIALOG = 11237, -- If'n ye have goods tae deliver, then Nembet be yer man!
        HOMEPOINT_SET        = 11136, -- Home point set!
    },
    mob =
    {
    },
    npc =
    {
        CAMPAIGN_NPC_OFFSET = GetFirstID('Saphiriance_TK'), -- not in the text table, must not appear
    },
}
`;
    const table = parseIdsTextTable(source);
    expect(table.ITEM_DELIVERY_DIALOG).toEqual({ id: 11237, text: "If'n ye have goods tae deliver, then Nembet be yer man!" });
    expect(table.HOMEPOINT_SET).toEqual({ id: 11136, text: 'Home point set!' });
    expect(table.CAMPAIGN_NPC_OFFSET).toBeUndefined();
  });

  it('handles an entry with no trailing comment', () => {
    const source = `
text =
{
    CONQUEST_BASE = 0,
    ASSIST_CHANNEL = 6539, -- You will be able to use the Assist Channel...
},
`;
    const table = parseIdsTextTable(source);
    expect(table.CONQUEST_BASE).toEqual({ id: 0, text: '' });
    expect(table.ASSIST_CHANNEL?.id).toBe(6539);
  });

  it('returns an empty object when there is no text table at all', () => {
    expect(parseIdsTextTable('zones[xi.zone.X] = { mob = {}, npc = {} }')).toEqual({});
  });
});

describe('extractTextRefs', () => {
  it('extracts every .text.CONST_NAME reference, deduped, in first-seen order', () => {
    const source = `
local ID = zones[xi.zone.SOUTHERN_SAN_DORIA_S]
entity.onTrigger = function(player, npc)
    if player:getQuestStatus(...) then
        player:showText(npc, ID.text.ITEM_DELIVERY_DIALOG)
    else
        player:showText(npc, ID.text.HOMEPOINT_SET)
        player:showText(npc, ID.text.ITEM_DELIVERY_DIALOG)
    end
end
`;
    expect(extractTextRefs(source)).toEqual(['ITEM_DELIVERY_DIALOG', 'HOMEPOINT_SET']);
  });

  it('returns an empty array when the script references no .text.* constants', () => {
    expect(extractTextRefs('entity.onTrigger = function(player, npc) player:tradeComplete(npc) end')).toEqual([]);
  });
});
