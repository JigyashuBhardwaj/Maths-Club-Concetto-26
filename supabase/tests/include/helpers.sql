-- Included by every test file (psql \ir). Not a test itself (the runner only executes *.test.sql at this level).
-- rejects(stmt, expected): the statement must fail, and the error must match `expected`
-- (a SQLSTATE such as 23505, a constraint name, or text inside the message). The failed statement is rolled back.
create function pg_temp.rejects(stmt text, expected text) returns void language plpgsql as $f$
declare msg text; st text; cname text;
begin
  begin
    execute stmt;
  exception when others then
    get stacked diagnostics msg = message_text, st = returned_sqlstate, cname = constraint_name;
    if st = expected or cname = expected or position(expected in msg) > 0 then return; end if;
    raise exception 'wrong rejection for [%]: sqlstate=% constraint=% message=% (wanted %)', stmt, st, cname, msg, expected;
  end;
  raise exception 'statement was NOT rejected (wanted %): %', expected, stmt;
end $f$;
