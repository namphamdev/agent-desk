src = open('src/model.rs').read() 
q = chr(34) 
bs = chr(92) 
nl = chr(10) 
bad = '        let buf = buf.replace(' + q + bs + 'r' + bs + 'n' + q + ', ' + q + bs + 'n' + q + ');' + nl + 'let mut content = String::new();' 
good = '    let buf = buf.replace(' + q + bs + 'r' + bs + 'n' + q + ', ' + q + bs + 'n' + q + ');' + nl + '    let mut content = String::new();' 
assert bad in src 
src = src.replace(bad, good) 
open('src/model.rs','w').write(src) 
