#!/bin/bash
# =============================================================================
# HARD STRESS TEST — memory service
# Tests: contradictions, opinion arcs, implicit chains, corrections,
#        preference evolution, multi-hop, noise resistance, key consistency
# User: Maya Patel — software architect, 6 sessions over 5 months
# =============================================================================

BASE="http://localhost:8080"
USER="maya-patel"
SESSION_BASE="maya-session"
PASS=0
FAIL=0
TOTAL=0

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

probe() {
  local label="$1"
  local query="$2"
  local expect_contains="$3"      # comma-separated strings ALL must appear
  local expect_not_contains="$4"  # comma-separated strings NONE must appear
  local max_tokens="${5:-512}"

  TOTAL=$((TOTAL + 1))

  local response
  response=$(curl -s -X POST "$BASE/recall" \
    -H "Content-Type: application/json" \
    -d "{\"query\":\"$query\",\"session_id\":\"probe-$$\",\"user_id\":\"$USER\",\"max_tokens\":$max_tokens}")

  local context
  context=$(echo "$response" | jq -r '.context // ""')
  local ctx_lower
  ctx_lower=$(echo "$context" | tr '[:upper:]' '[:lower:]')

  local failed=0
  local fail_reason=""

  # Check must-contain strings
  if [ -n "$expect_contains" ]; then
    IFS=',' read -ra MUST <<< "$expect_contains"
    for term in "${MUST[@]}"; do
      term=$(echo "$term" | tr '[:upper:]' '[:lower:]' | xargs)
      if ! echo "$ctx_lower" | grep -q "$term"; then
        failed=1
        fail_reason="missing: '$term'"
        break
      fi
    done
  fi

  # Check must-not-contain strings
  if [ -n "$expect_not_contains" ] && [ $failed -eq 0 ]; then
    IFS=',' read -ra MUST_NOT <<< "$expect_not_contains"
    for term in "${MUST_NOT[@]}"; do
      term=$(echo "$term" | tr '[:upper:]' '[:lower:]' | xargs)
      if echo "$ctx_lower" | grep -q "$term"; then
        failed=1
        fail_reason="should not contain: '$term'"
        break
      fi
    done
  fi

  if [ $failed -eq 0 ]; then
    echo -e "${GREEN}✓${NC} $label"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}✗${NC} $label"
    echo -e "  ${YELLOW}reason:${NC} $fail_reason"
    echo -e "  ${YELLOW}context:${NC} $(echo "$context" | head -c 300)"
    FAIL=$((FAIL + 1))
  fi
}

ingest() {
  local session="$1"
  local timestamp="$2"
  local content="$3"
  local assistant="${4:-Got it.}"

  local result
  result=$(curl -s -X POST "$BASE/turns" \
    -H "Content-Type: application/json" \
    -d "{
      \"session_id\": \"$session\",
      \"user_id\": \"$USER\",
      \"messages\": [
        {\"role\": \"user\", \"content\": $(echo "$content" | jq -Rs .)},
        {\"role\": \"assistant\", \"content\": $(echo "$assistant" | jq -Rs .)}
      ],
      \"timestamp\": \"${timestamp}T10:00:00Z\",
      \"metadata\": {}
    }")

  local id
  id=$(echo "$result" | jq -r '.id // "ERROR"')
  if [ "$id" = "ERROR" ]; then
    echo -e "  ${RED}ingest failed:${NC} $result"
  fi
  echo "$id"
}

# =============================================================================
echo ""
echo "═══════════════════════════════════════════"
echo "  CLEANUP"
echo "═══════════════════════════════════════════"
curl -s -X DELETE "$BASE/users/$USER" > /dev/null && echo "deleted $USER"
sleep 2

# =============================================================================
echo ""
echo "═══════════════════════════════════════════"
echo "  SESSION 1 — 2025-01-05"
echo "  Establishes: employer, location, role,"
echo "  diet, family, TS opinion (positive)"
echo "═══════════════════════════════════════════"

ingest "${SESSION_BASE}-1" "2025-01-05" \
  "I just joined Vercel as a staff engineer — super excited, been following their work for years. We're based in San Francisco, my partner Lena and I moved here from Toronto two years ago. She's a UX designer at Figma which is kind of perfect. I'm working on the edge runtime team, mostly TypeScript all day. Honestly TypeScript is the best thing to happen to JavaScript — I don't know how people built large systems without it." \
  "Vercel is doing amazing work. How are you finding San Francisco compared to Toronto?" > /dev/null
sleep 1

ingest "${SESSION_BASE}-1" "2025-01-05" \
  "San Francisco is expensive but worth it for the network. One thing that helps — I've been vegan for about four years now, and the food scene here is incredible for it. Also way more hiking than Toronto. I usually go every Sunday with our dog Churro, he's a 3-year-old golden retriever." \
  "A vegan golden retriever owner on the edge runtime team — that's a very specific San Francisco archetype." > /dev/null
sleep 1

echo "Session 1 done."

# =============================================================================
echo ""
echo "═══════════════════════════════════════════"
echo "  SESSION 2 — 2025-02-10"
echo "  Contradictions: location (SF→remote/NYC consideration)"
echo "  Opinion drift: TS still positive but nuanced"
echo "  New: React opinion, work preference"
echo "═══════════════════════════════════════════"

ingest "${SESSION_BASE}-2" "2025-02-10" \
  "Six weeks at Vercel. The edge runtime work is fascinating but I'm starting to feel the TypeScript compiler fight me on complex generic inference — it's not a dealbreaker but the error messages are genuinely cryptic sometimes. Still wouldn't go back to plain JS for a large codebase though." \
  "Generic inference errors are a TypeScript rite of passage. What are you building on edge?" > /dev/null
sleep 1

ingest "${SESSION_BASE}-2" "2025-02-10" \
  "Mostly routing and middleware. We use React for the dashboard and honestly I'm less enthusiastic about React than I used to be — the mental model with hooks is fine but the re-render debugging is a nightmare. Been looking at some of the signals-based frameworks. Also Vercel is pretty flexible about location, I've been considering spending a few months in New York — Lena has family there and the time zone works better for some of our European customers." \
  "Signals are interesting. Are you looking at Solid or Svelte?" > /dev/null
sleep 1

echo "Session 2 done."

# =============================================================================
echo ""
echo "═══════════════════════════════════════════"
echo "  SESSION 3 — 2025-03-01"
echo "  Hard contradictions:"
echo "    - location: SF → NYC (moved, explicit)"
echo "    - diet: vegan → vegetarian (correction)"
echo "    - dog age correction: 3 → 4 (birthday)"
echo "  New: meditation habit (implicit)"
echo "═══════════════════════════════════════════"

ingest "${SESSION_BASE}-3" "2025-03-01" \
  "Update — we made the move. Lena and I are in Brooklyn now, Williamsburg specifically. Vercel is fine with it, I'm fully remote. Churro loves the dog parks here, he just turned 4 last week actually, I keep forgetting he's not 3 anymore." \
  "Brooklyn is a great choice. How's the adjustment been?" > /dev/null
sleep 1

ingest "${SESSION_BASE}-3" "2025-03-01" \
  "Really good. Oh and I should correct something — I said I was vegan but I've actually been vegetarian for the past year, I occasionally have dairy. Not a huge deal but I don't want to be that person who orders the wrong thing at dinner. Also I've been doing a 10-minute meditation every morning before I open my laptop, helps with the context switching between deep engineering work and meetings." \
  "Vegetarian is easier to navigate at most restaurants anyway. What's your meditation practice?" > /dev/null
sleep 1

echo "Session 3 done."

# =============================================================================
echo ""
echo "═══════════════════════════════════════════"
echo "  SESSION 4 — 2025-03-20"
echo "  Hard contradictions:"
echo "    - employer: Vercel → leaving for Anthropic"
echo "    - role: staff engineer → research engineer"
echo "  Opinion arcs:"
echo "    - React: from negative to reconsidering"
echo "    - TS: now mixed (likes it but has real criticism)"
echo "═══════════════════════════════════════════"

ingest "${SESSION_BASE}-4" "2025-03-20" \
  "Big news — I'm leaving Vercel. Got an offer from Anthropic for a research engineer role on their evals team. It's a different kind of work, more Python than TypeScript ironically, and I've been wrestling with whether the TypeScript strictness I loved is actually slowing me down versus just feeling productive. Python's flexibility is starting to look appealing for research-style iteration." \
  "Anthropic evals is fascinating work. When do you start?" > /dev/null
sleep 1

ingest "${SESSION_BASE}-4" "2025-03-20" \
  "Three weeks. I've been doing some prep work in Python and honestly I've missed it — the iteration speed for exploratory work is just different. I still think TypeScript is the right call for large production systems with big teams, but for research and prototyping it's overkill. Also reconsidering React — I looked at some of the newer Next.js patterns and the mental model has actually improved a lot. Less hook spaghetti than I remember." \
  "The TypeScript vs Python divide is very real in research vs production contexts." > /dev/null
sleep 1

echo "Session 4 done."

# =============================================================================
echo ""
echo "═══════════════════════════════════════════"
echo "  SESSION 5 — 2025-04-15"
echo "  Contradictions:"
echo "    - location: Brooklyn → considering SF return"
echo "    - preference: remote → wants office time"
echo "  New facts: expecting a child (implicit then explicit)"
echo "  Opinion: Python now primary, TS for specific contexts"
echo "═══════════════════════════════════════════"

ingest "${SESSION_BASE}-5" "2025-04-15" \
  "One month at Anthropic. The evals work is incredible — I'm writing more Python than I have in years and the research iteration speed is exactly what I wanted. TypeScript feels like the wrong tool for this now, though I'd still use it for a production API. Also Lena and I have some news — she's pregnant, due in October. Which is making us rethink Brooklyn — her parents are in San Francisco and my parents are in Toronto." \
  "Congratulations! That's huge news. The grandparent geography problem is real." > /dev/null
sleep 1

ingest "${SESSION_BASE}-5" "2025-04-15" \
  "We're leaning toward going back to San Francisco actually. Anthropic has an office there and I've realized I actually miss having an office to go to a few days a week — remote was great for a while but I miss the serendipitous conversations. Churro would also prefer California weather, I think. He hates the cold." \
  "The pendulum swinging back to office time is pretty common after fully remote." > /dev/null
sleep 1

echo "Session 5 done."

# =============================================================================
echo ""
echo "═══════════════════════════════════════════"
echo "  SESSION 6 — 2025-05-09 (today)"
echo "  Final state:"
echo "    - location: back in SF (confirmed)"
echo "    - preference: hybrid (3 days office)"  
echo "    - TS opinion: arc complete"
echo "    - React opinion: arc complete"
echo "    - Python: now primary language"
echo "    - New: coffee preference (implicit)"
echo "═══════════════════════════════════════════"

ingest "${SESSION_BASE}-6" "2025-05-09" \
  "We're back in San Francisco as of last week. Lena found a remote design role so it was doable. I'm going into the Anthropic office Monday, Wednesday, Friday — hybrid feels right. Churro is thrilled. I went to the climbing gym yesterday for the first time in months, forgot how much I missed it. Also my whole relationship with TypeScript has shifted — I see it now as a production infrastructure tool, not a default. For anything exploratory or research-y, Python. For APIs and systems with teams, TypeScript. That nuance took me a year to arrive at." \
  "That's a mature take on the TypeScript vs Python question. How's the evals work going?" > /dev/null
sleep 1

ingest "${SESSION_BASE}-6" "2025-05-09" \
  "Really well. We've been building evaluation harnesses for language models and it's the most intellectually interesting work I've done. React I've fully made peace with — the ecosystem is just too large to ignore and the patterns have genuinely improved. I grab an oat milk flat white from the same place every morning before office days, it's become a ritual. Due date is October 15th, starting to feel real." \
  "Evals work is underrated in terms of impact. Oat milk flat white is the correct San Francisco morning ritual." > /dev/null
sleep 1

echo "Session 6 done."

# =============================================================================
echo ""
echo "═══════════════════════════════════════════"
echo "  MEMORY STATE INSPECTION"
echo "═══════════════════════════════════════════"

echo ""
echo "--- Supersession chains (keys with history) ---"
curl -s "$BASE/users/$USER/memories" | jq '
  .memories
  | group_by(.key)
  | map(select(length > 1))
  | map({
      key: .[0].key,
      versions: length,
      current: (map(select(.active == true)) | .[0].value // "NONE ACTIVE"),
      history: (map(select(.active == false)) | map(.value))
    })'

echo ""
echo "--- All active memories ---"
curl -s "$BASE/users/$USER/memories" | jq '
  .memories
  | map(select(.active == true))
  | sort_by(.key)
  | map({key, type, value, confidence})'

# =============================================================================
echo ""
echo "═══════════════════════════════════════════"
echo "  PROBE QUERIES"
echo "═══════════════════════════════════════════"

echo ""
echo "--- FACT CONTRADICTIONS ---"

probe \
  "Location: final state is SF not Brooklyn not Toronto" \
  "Where does the user currently live?" \
  "san francisco,francisco" \
  "brooklyn,toronto,new york"

probe \
  "Employer: Anthropic not Vercel" \
  "Where does the user work?" \
  "anthropic" \
  "vercel"

probe \
  "Role: research engineer not staff engineer" \
  "What is the user's current job title?" \
  "research" \
  ""

probe \
  "Diet: vegetarian not vegan" \
  "What is the user's diet?" \
  "vegetarian" \
  "vegan"

probe \
  "Dog age: 4 not 3 (corrected)" \
  "How old is the user's dog?" \
  "4" \
  ""

echo ""
echo "--- IMPLICIT FACTS ---"

probe \
  "Partner name: Lena (implicit from 'my partner Lena')" \
  "Does the user have a partner? What is their name?" \
  "lena" \
  ""

probe \
  "Partner job: UX designer at Figma (implicit)" \
  "What does the user's partner do for work?" \
  "figma,design" \
  ""

probe \
  "Dog name and breed: Churro, golden retriever" \
  "What is the user's dog's name and breed?" \
  "churro,golden" \
  ""

probe \
  "Hobbies: climbing and hiking (both implicit)" \
  "What are the user's hobbies and activities?" \
  "climb,hik" \
  ""

probe \
  "Morning routine: meditation (implicit habit)" \
  "Does the user have any morning habits or routines?" \
  "meditat" \
  ""

probe \
  "Coffee preference: oat milk flat white (very implicit)" \
  "What does the user drink in the morning?" \
  "oat,flat white" \
  ""

probe \
  "Baby due date: October (explicit in session 6)" \
  "When is the user's baby due?" \
  "october" \
  ""

echo ""
echo "--- OPINION ARCS ---"

probe \
  "TypeScript: nuanced positive (not simple love/hate)" \
  "What does the user think about TypeScript?" \
  "typescript" \
  ""

probe \
  "Python: now preferred for research (arc from TS-lover)" \
  "What language does the user prefer and why?" \
  "python" \
  ""

probe \
  "React: made peace with it (arc from negative)" \
  "What does the user think about React?" \
  "react" \
  ""

echo ""
echo "--- PREFERENCES ---"

probe \
  "Work style: hybrid (evolved from remote)" \
  "How does the user prefer to work — remote or office?" \
  "hybrid,office" \
  ""

probe \
  "Location preference: SF over Brooklyn (evolved)" \
  "Does the user prefer San Francisco or New York?" \
  "san francisco,francisco" \
  "brooklyn"

echo ""
echo "--- MULTI-HOP ---"

probe \
  "Multi-hop: dog breed + current city" \
  "What breed is the user's dog and what city does it live in?" \
  "golden,san francisco" \
  ""

probe \
  "Multi-hop: partner employer + user employer (same tech scene)" \
  "Where do the user and their partner work?" \
  "anthropic,figma" \
  ""

probe \
  "Multi-hop: baby due date + current location" \
  "Where will the user's baby be born based on where they live?" \
  "san francisco,francisco,october" \
  ""

echo ""
echo "--- NOISE RESISTANCE ---"

probe \
  "Noise: climate policy (never mentioned)" \
  "What does the user think about climate change policy?" \
  "" \
  "vercel,anthropic,typescript,san francisco"

probe \
  "Noise: cryptocurrency (never mentioned)" \
  "Does the user invest in cryptocurrency?" \
  "" \
  "churro,lena,anthropic"

probe \
  "Noise: cooking preferences (never mentioned)" \
  "What does the user like to cook?" \
  "" \
  "typescript,vercel,brooklyn"

echo ""
echo "--- SUPERSESSION INTEGRITY ---"

echo ""
echo "Checking supersession chains via memories endpoint..."

MEMORIES=$(curl -s "$BASE/users/$USER/memories")

# Check location chain: SF → Brooklyn → SF
LOCATION_COUNT=$(echo "$MEMORIES" | jq '[.memories[] | select(.key == "location")] | length')
LOCATION_ACTIVE=$(echo "$MEMORIES" | jq '[.memories[] | select(.key == "location" and .active == true)] | length')
TOTAL=$((TOTAL + 1))
if [ "$LOCATION_COUNT" -ge 2 ] && [ "$LOCATION_ACTIVE" -eq 1 ]; then
  echo -e "${GREEN}✓${NC} Location supersession chain intact ($LOCATION_COUNT versions, 1 active)"
  PASS=$((PASS + 1))
else
  echo -e "${RED}✗${NC} Location chain broken: $LOCATION_COUNT versions, $LOCATION_ACTIVE active"
  FAIL=$((FAIL + 1))
fi

# Check employer chain: Vercel → Anthropic
EMPLOYER_COUNT=$(echo "$MEMORIES" | jq '[.memories[] | select(.key == "employer")] | length')
EMPLOYER_ACTIVE_VAL=$(echo "$MEMORIES" | jq -r '[.memories[] | select(.key == "employer" and .active == true)] | .[0].value // ""' | tr '[:upper:]' '[:lower:]')
TOTAL=$((TOTAL + 1))
if echo "$EMPLOYER_ACTIVE_VAL" | grep -q "anthropic"; then
  echo -e "${GREEN}✓${NC} Employer superseded: Vercel → Anthropic ($EMPLOYER_COUNT versions)"
  PASS=$((PASS + 1))
else
  echo -e "${RED}✗${NC} Employer active value wrong: '$EMPLOYER_ACTIVE_VAL'"
  FAIL=$((FAIL + 1))
fi

# Check diet: vegan → vegetarian
DIET_ACTIVE_VAL=$(echo "$MEMORIES" | jq -r '[.memories[] | select(.key == "diet" and .active == true)] | .[0].value // ""' | tr '[:upper:]' '[:lower:]')
TOTAL=$((TOTAL + 1))
if echo "$DIET_ACTIVE_VAL" | grep -q "vegetarian"; then
  echo -e "${GREEN}✓${NC} Diet superseded: vegan → vegetarian"
  PASS=$((PASS + 1))
else
  echo -e "${RED}✗${NC} Diet active value wrong: '$DIET_ACTIVE_VAL'"
  FAIL=$((FAIL + 1))
fi

# =============================================================================
echo ""
echo "═══════════════════════════════════════════"
echo "  RESULTS"
echo "═══════════════════════════════════════════"
echo ""
echo -e "  Passed: ${GREEN}$PASS${NC}"
echo -e "  Failed: ${RED}$FAIL${NC}"
echo -e "  Total:  $TOTAL"
echo ""

if [ $FAIL -eq 0 ]; then
  echo -e "  ${GREEN}All probes passed.${NC}"
elif [ $FAIL -le 3 ]; then
  echo -e "  ${YELLOW}Minor gaps — check failed probes above.${NC}"
else
  echo -e "  ${RED}Significant gaps — review extraction and retrieval pipelines.${NC}"
fi

echo ""
echo "  Scoring guide:"
echo "  25-28 / 28  → excellent, ready to submit"
echo "  20-24 / 28  → good, document gaps in CHANGELOG"
echo "  < 20  / 28  → investigate extraction or recall issues"
echo ""