-- Workout tracker schema. Run in Supabase: SQL Editor -> paste -> Run.
create type muscle_group as enum ('push','pull','legs');

-- user_id null = built-in row visible to everyone; non-null = your custom row
create table exercises (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade,
  name text not null,
  pool text not null,               -- slot pool, e.g. 'horizontal_press'
  muscle_group muscle_group not null,
  is_bodyweight boolean not null default false,  -- weight field = added load
  increment numeric not null default 5,
  sort_order int not null default 0,             -- lowest in a pool = default
  unique nulls not distinct (user_id, name)
);

create table program_slots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade,
  day_type muscle_group not null,
  position int not null,
  pool text not null,
  sets int not null default 3,
  rep_min int not null,
  rep_max int not null,
  optional boolean not null default false
);

-- which exercise currently fills a slot (changes on rotation)
create table slot_state (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  slot_id uuid not null references program_slots on delete cascade,
  exercise_id uuid not null references exercises,
  primary key (user_id, slot_id)
);

-- per-exercise progression state; kept when an exercise is rotated out
create table exercise_state (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  exercise_id uuid not null references exercises on delete cascade,
  status text not null default 'calibrating' check (status in ('calibrating','active')),
  current_weight numeric,
  target_reps int[],
  stall_count int not null default 0,
  last_total_reps int,
  last_weight numeric,
  last_progressed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, exercise_id)
);

create table workout_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  day_type muscle_group not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

-- prescription (target_*) is stored beside what you actually did
create table set_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  session_id uuid not null references workout_sessions on delete cascade,
  slot_id uuid not null references program_slots,
  exercise_id uuid not null references exercises,
  set_number int not null,
  target_weight numeric,
  target_reps int,
  actual_weight numeric,
  actual_reps int,
  skipped boolean not null default false,
  notes text,
  completed_at timestamptz not null default now(),
  unique (session_id, slot_id, exercise_id, set_number)
);
create index on set_logs (exercise_id, completed_at desc);

create table body_weight_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  logged_on date not null default current_date,
  weight numeric not null,
  unique (user_id, logged_on)
);

-- PRs: heaviest weight and best estimated 1RM (Epley)
create view exercise_prs with (security_invoker = true) as
select user_id, exercise_id,
       max(actual_weight) as best_weight,
       max(actual_weight * (1 + actual_reps / 30.0)) as best_e1rm
from set_logs where actual_reps > 0 and not skipped
group by user_id, exercise_id;

-- Row Level Security
do $$ declare t text; begin
  foreach t in array array['slot_state','exercise_state','workout_sessions','set_logs','body_weight_logs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "own rows" on %I for all using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
  foreach t in array array['exercises','program_slots'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "read built-in + own" on %I for select using (user_id is null or user_id = auth.uid())', t);
    execute format('create policy "write own" on %I for all using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- Seed: first name in each pool is the default
with p(pool, grp, inc, names) as (values
 ('horizontal_press','push',5,  array['Barbell bench press','Dumbbell bench press','Machine chest press','Weighted dips']),
 ('incline_press','push',5,     array['Incline barbell bench press','Incline dumbbell press','Incline machine press']),
 ('overhead_press','push',5,    array['Barbell shoulder press','Dumbbell shoulder press','Machine shoulder press','Landmine press']),
 ('lateral_delts','push',2.5,   array['Cable lateral raise','Dumbbell lateral raise','Machine lateral raise']),
 ('triceps','push',2.5,         array['Cable pushdown','Cable triceps extension','Overhead cable extension','Skull crushers','Close-grip bench press']),
 ('bodyweight_push','push',5,   array['Push-ups','Weighted push-ups','Deficit push-ups','Decline push-ups']),
 ('chest_isolation','push',2.5, array['Cable fly','Pec deck']),
 ('vertical_pull','pull',5,     array['Pull-ups','Weighted pull-ups','Chin-ups','Neutral-grip pull-ups','Lat pulldown','Assisted pull-ups']),
 ('horizontal_row','pull',5,    array['Cable row','Dumbbell row','Chest-supported row','Barbell row','T-bar row']),
 ('rear_delts','pull',2.5,      array['Face pulls','Rear delt fly','Reverse pec deck']),
 ('biceps','pull',2.5,          array['Cable curl','Machine curl','Preacher curl','Dumbbell curl','Hammer curl','Incline dumbbell curl','EZ-bar curl']),
 ('squat_pattern','legs',10,    array['Back squat','Front squat','Leg press','Hack squat','Bulgarian split squat','Goblet squat']),
 ('hip_hinge','legs',10,        array['Barbell RDL','Dumbbell RDL','Hip thrust']),
 ('quads','legs',5,             array['Leg extension','Sissy squat']),
 ('hamstrings','legs',5,        array['Hamstring curl','Nordic curl']),
 ('calves','legs',5,            array['Calf machine','Standing calf raise','Seated calf raise']))
insert into exercises (name, pool, muscle_group, increment, sort_order)
select n, pool, grp::muscle_group, inc, ord
from p, unnest(names) with ordinality as u(n, ord);

update exercises set is_bodyweight = true where user_id is null and name in
 ('Push-ups','Weighted push-ups','Deficit push-ups','Decline push-ups','Pull-ups','Weighted pull-ups',
  'Chin-ups','Neutral-grip pull-ups','Weighted dips','Nordic curl','Sissy squat');

insert into program_slots (day_type, position, pool, sets, rep_min, rep_max, optional) values
 ('push',1,'horizontal_press',3,6,10,false), ('push',2,'incline_press',3,6,10,false),
 ('push',3,'overhead_press',3,6,10,false),   ('push',4,'lateral_delts',3,10,15,false),
 ('push',5,'triceps',3,10,15,false),         ('push',6,'bodyweight_push',3,8,15,true),
 ('push',7,'chest_isolation',3,10,15,true),
 ('pull',1,'vertical_pull',3,6,10,false),    ('pull',2,'horizontal_row',3,6,10,false),
 ('pull',3,'rear_delts',3,10,15,false),      ('pull',4,'biceps',3,10,15,false),
 ('legs',1,'squat_pattern',3,6,10,false),    ('legs',2,'hip_hinge',3,6,10,false),
 ('legs',3,'quads',3,10,15,false),           ('legs',4,'hamstrings',3,10,15,false),
 ('legs',5,'calves',3,10,15,false);
