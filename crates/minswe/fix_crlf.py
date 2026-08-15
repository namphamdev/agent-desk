src = open('src/model.rs').read() 
old = 'let mut content = String::new();' 
q = chr(34) 
bs = chr(92) 
one = 1  
line = '    let buf = buf.replace(' + q + bs + 'r' + bs + 'n' + q + ', ' + q + bs + 'n' + q + ');' 
new = line + chr(10) + old 
assert src.count(old) == one 
src = src.replace(old, new) 
open('src/model.rs','w').write(src) 
