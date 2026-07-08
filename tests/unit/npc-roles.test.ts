import { describe, it, expect } from 'vitest';
import { classifyNpcScript } from '../../src/npc-roles';

describe('classifyNpcScript', () => {
  it('detects a single role from a shop script', () => {
    const source = `
entity.onTrigger = function(player, npc)
    local stock = { { xi.item.FISH_MITHKABOB, 1134 } }
    xi.shop.general(player, stock, xi.fameArea.WINDURST)
end
`;
    expect(classifyNpcScript(source)).toEqual(['shop']);
  });

  it('detects multiple roles, in fixed order, when a script references more than one namespace', () => {
    const source = `
entity.onTrigger = function(player, npc)
    if player:getQuestStatus(xi.quest.log.WINDURST, xi.quest.id.windurst.SOME_QUEST) == xi.questStatus.QUEST_ACCEPTED then
        xi.shop.general(player, stock)
    end
end
`;
    expect(classifyNpcScript(source)).toEqual(['shop', 'quest']);
  });

  it('detects mission and homepoint roles independently', () => {
    expect(classifyNpcScript('xi.mission.getMissionStatus(player, xi.mission.log_id.WINDURST)')).toEqual(['mission']);
    expect(classifyNpcScript('xi.homepoint.set(player, npc)')).toEqual(['homepoint']);
  });

  it('returns an empty array for a script matching no known role', () => {
    expect(classifyNpcScript('entity.onTrigger = function(player, npc) player:showText(npc, ID.text.GREETING) end')).toEqual([]);
  });

  it('does not false-positive on unrelated text containing "shop" without the xi.shop. prefix', () => {
    expect(classifyNpcScript('-- This NPC used to run a shopping errand, not implemented')).toEqual([]);
  });
});
